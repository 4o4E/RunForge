import { isAbsolute, posix } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { BusinessPluginError } from './errors.js';
import type { BusinessPluginManifest } from './types.js';

const ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SECRET_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function relativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized
    || isAbsolute(value)
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error('必须是业务插件目录内的相对路径');
  }
  return posix.normalize(normalized);
}

const idSchema = z.string().trim()
  .regex(ID_RE, '只允许小写字母、数字、点、下划线和短横线')
  .refine((value) => !value.includes('__'), '不能包含 MCP 工具名保留分隔符 __');
const secretKeySchema = z.string().trim().regex(SECRET_KEY_RE, 'Secret key 格式无效');
const jsonObjectSchema = z.record(z.string(), z.unknown()).default({});

const skillSchema = z.object({
  id: idSchema,
  path: z.string().trim().transform(relativePath),
}).strict();

const mcpHeaderSchema = z.object({
  name: z.string().trim().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, '不是有效的 HTTP Header 名称'),
  value: z.string().refine(
    (item) => !/[\u0000-\u0008\u000A-\u001F\u007F]/.test(item),
    '包含 HTTP Header 不允许的控制字符',
  ).optional(),
  secretKey: secretKeySchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.value === undefined) === (value.secretKey === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'MCP header 必须且只能声明 value 或 secretKey 之一' });
  }
});

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === 'authorization'
    || normalized === 'proxy-authorization'
    || normalized === 'api-key'
    || normalized.endsWith('-api-key')
    || normalized === 'token'
    || normalized.endsWith('-token')
    || normalized === 'secret'
    || normalized.endsWith('-secret');
}

const mcpSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  transport: z.literal('streamable-http').default('streamable-http'),
  url: z.url().optional(),
  urlConfigKey: z.string().trim().min(1).optional(),
  bearerSecretKey: secretKeySchema.optional(),
  headers: z.array(mcpHeaderSchema).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  maxOutput: z.number().int().min(1_000).max(1_000_000).default(40_000),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.url) === Boolean(value.urlConfigKey)) {
    ctx.addIssue({ code: 'custom', message: 'MCP 必须且只能声明 url 或 urlConfigKey 之一' });
  }
  if (value.url && !/^https?:$/.test(new URL(value.url).protocol)) {
    ctx.addIssue({ code: 'custom', message: 'MCP URL 只支持 http/https' });
  }
  if (value.url) {
    const parsedUrl = new URL(value.url);
    if (parsedUrl.username || parsedUrl.password) {
      ctx.addIssue({ code: 'custom', message: 'MCP URL 不能包含用户名或密码，请改用 tenant Secret' });
    }
  }
  if (value.bearerSecretKey && value.headers.some((header) => header.name.toLowerCase() === 'authorization')) {
    ctx.addIssue({ code: 'custom', message: 'bearerSecretKey 不能和 Authorization header 同时声明' });
  }
  const headerNames = value.headers.map((header) => header.name.toLowerCase());
  const duplicateHeader = headerNames.find((name, index) => headerNames.indexOf(name) !== index);
  if (duplicateHeader) {
    ctx.addIssue({ code: 'custom', message: `MCP header 不能重复声明：${duplicateHeader}` });
  }
  const plaintextSensitiveHeader = value.headers.find((header) => (
    header.value !== undefined && isSensitiveHeaderName(header.name)
  ));
  if (plaintextSensitiveHeader) {
    ctx.addIssue({
      code: 'custom',
      message: `敏感 MCP header ${plaintextSensitiveHeader.name} 必须通过 secretKey 引用 tenant Secret`,
    });
  }
});

const secretSchema = z.object({
  key: secretKeySchema,
  required: z.boolean().default(true),
  access: z.array(z.enum(['backend', 'workload'])).min(1).default(['backend']),
  description: z.string().trim().default(''),
}).strict();

const resourceSchema = z.object({
  type: idSchema,
  config: jsonObjectSchema,
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  version: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1),
  skills: z.array(skillSchema).default([]),
  mcpServers: z.array(mcpSchema).default([]),
  secrets: z.array(secretSchema).default([]),
  resources: z.array(resourceSchema).default([]),
  configSchema: jsonObjectSchema,
}).strict();

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}

export function parseBusinessPluginManifest(content: string, file: string): BusinessPluginManifest {
  let decoded: unknown;
  try {
    decoded = parse(content);
  } catch (error) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_MANIFEST_INVALID',
      `${file} 不是有效 YAML：${(error as Error).message}`,
      { cause: error },
    );
  }

  const parsed = manifestSchema.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_MANIFEST_INVALID',
      `${file} manifest 无效：${path}${issue?.message ?? '未知错误'}`,
    );
  }

  const value = parsed.data;
  const duplicates = [
    ['Skill', duplicate(value.skills.map((item) => item.id))],
    ['MCP', duplicate(value.mcpServers.map((item) => item.id))],
    ['Secret', duplicate(value.secrets.map((item) => item.key))],
    ['运行资源', duplicate(value.resources.map((item) => item.type))],
  ] as const;
  const duplicateItem = duplicates.find(([, id]) => id);
  if (duplicateItem) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_MANIFEST_INVALID',
      `${file} 重复声明${duplicateItem[0]}：${duplicateItem[1]}`,
    );
  }

  const declaredSecrets = new Map(value.secrets.map((item) => [item.key, item]));
  for (const server of value.mcpServers) {
    const referenced = [
      server.bearerSecretKey,
      ...server.headers.map((header) => header.secretKey),
    ].filter((item): item is string => Boolean(item));
    const missing = referenced.find((key) => !declaredSecrets.has(key));
    if (missing) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_SECRET_MISSING',
        `${file} 的 MCP ${server.id} 引用了未声明的 tenant Secret key：${missing}`,
      );
    }
    const backendDenied = referenced.find((key) => !declaredSecrets.get(key)?.access.includes('backend'));
    if (backendDenied) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_MANIFEST_INVALID',
        `${file} 的 MCP ${server.id} 引用的 Secret 未授权 backend：${backendDenied}`,
      );
    }
  }

  return {
    ...value,
    displayName: value.displayName ?? value.id,
    mcpServers: value.mcpServers.map((server) => ({
      ...server,
      label: server.label ?? server.id,
      description: server.description ?? server.label ?? server.id,
    })),
  };
}
