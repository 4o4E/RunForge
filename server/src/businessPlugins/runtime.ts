import { randomUUID } from 'node:crypto';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { validateHeaderValue } from 'node:http';
import { join, resolve } from 'node:path';
import type { McpServerSettings } from '@runforge/contracts';
import { CordisRuntimeManager } from '../plugins/runtime.js';
import type { SpaceRuntimeLock } from '../plugins/types.js';
import { readSkillIndexItem, type SkillIndexItem } from '../skills/registry.js';
import { createBusinessPluginCordisDefinition } from './cordis.js';
import { BusinessPluginError } from './errors.js';
import { loadBusinessPlugin } from './registry.js';
import type {
  BusinessMcpServerDeclaration,
  BusinessPluginDefinition,
} from './types.js';

export type TenantSecretResolver = (
  tenantId: string,
  keys: readonly string[],
) => Promise<Readonly<Record<string, string>>>;

export interface BusinessPluginRuntimeInput {
  runId: string;
  workspaceRoot: string;
  definitions: readonly BusinessPluginDefinition[];
  lock: SpaceRuntimeLock;
  /** tenant 级非敏感配置；空间不能覆盖。 */
  tenantConfig?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  resolveSecrets?: TenantSecretResolver;
}

export interface BusinessPluginRunHandle {
  skills: SkillIndexItem[];
  mcpServers: McpServerSettings[];
  refreshMcpServers(): Promise<McpServerSettings[]>;
  dispose(): Promise<void>;
}

interface SkillContributionValue {
  businessPluginId: string;
  definition: { id: string; path: string };
}

interface McpContributionValue {
  businessPluginId: string;
  definition: BusinessMcpServerDeclaration;
}

function materializedPluginRoot(
  workspaceRoot: string,
  pluginId: string,
  contentHash: string,
): string {
  return resolve(
    workspaceRoot,
    '.agents/business-plugins',
    pluginId,
    contentHash,
    'plugin',
  );
}

async function materializePlugin(
  workspaceRoot: string,
  pluginId: string,
  contentHash: string,
  candidate?: BusinessPluginDefinition,
): Promise<BusinessPluginDefinition> {
  const target = materializedPluginRoot(workspaceRoot, pluginId, contentHash);
  if (existsSync(target)) {
    try {
      const cached = await loadBusinessPlugin(target);
      if (cached.manifest.id === pluginId && cached.contentHash === contentHash) return cached;
    } catch {
      // 下方统一删除损坏副本；部署源仍是同一 hash 时可立即重新复制，否则走标准不可用错误。
    }
    await rm(target, { recursive: true, force: true });
  }
  if (!candidate || candidate.manifest.id !== pluginId || candidate.contentHash !== contentHash) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_NOT_READY',
      `业务插件部署和运行副本均不可用：${pluginId} (${contentHash})`,
    );
  }

  // 部署目录可能在索引后被原子替换；复制前重新计算 hash，不能把新内容写进旧 hash 路径。
  const fresh = await loadBusinessPlugin(candidate.root);
  if (fresh.contentHash !== contentHash || fresh.manifest.id !== pluginId) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_NOT_READY',
      `业务插件 ${pluginId} 已更新，当前 run 需要的内容 ${contentHash} 不再可用`,
    );
  }
  const parent = resolve(target, '..');
  await mkdir(parent, { recursive: true });
  const staging = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await cp(fresh.root, staging, { recursive: true });
    try {
      await rename(staging, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const snapshot = await loadBusinessPlugin(target);
  if (snapshot.contentHash !== contentHash || snapshot.manifest.id !== pluginId) {
    await rm(target, { recursive: true, force: true });
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_NOT_READY',
      `业务插件 ${pluginId} 在复制期间发生变化，拒绝启动 run`,
    );
  }
  return snapshot;
}

function stringConfig(config: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredSecret(
  secrets: Readonly<Record<string, string>>,
  pluginId: string,
  key: string,
): string {
  const value = Object.hasOwn(secrets, key) ? secrets[key] : undefined;
  if (!value?.trim()) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_SECRET_UNAVAILABLE',
      `业务插件 ${pluginId} 缺少 tenant Secret：${key}`,
    );
  }
  return value;
}

function baseMcpServer(
  contribution: McpContributionValue,
  config: Readonly<Record<string, unknown>>,
): McpServerSettings {
  const { businessPluginId, definition } = contribution;
  const url = definition.url ?? (definition.urlConfigKey ? stringConfig(config, definition.urlConfigKey) : null);
  if (!url) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_CONFIG_INVALID',
      `业务插件 ${businessPluginId} 的 MCP ${definition.id} 缺少 tenant 配置 ${definition.urlConfigKey ?? 'url'}`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch (error) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_CONFIG_INVALID',
      `业务插件 ${businessPluginId} 的 MCP ${definition.id} URL 无效`,
      { cause: error },
    );
  }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_CONFIG_INVALID',
      `业务插件 ${businessPluginId} 的 MCP ${definition.id} URL 必须是无凭证的 HTTP/HTTPS 地址`,
    );
  }
  return {
    id: `business-${businessPluginId}-${definition.id}`,
    label: definition.label,
    description: definition.description,
    enabled: true,
    url,
    bearerToken: '',
    headers: definition.headers.map((header) => ({
      name: header.name,
      value: header.value ?? '',
    })),
    timeoutMs: definition.timeoutMs,
    maxOutput: definition.maxOutput,
  };
}

function resolveMcpServer(
  contribution: McpContributionValue,
  config: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
): McpServerSettings {
  const { businessPluginId, definition } = contribution;
  const server = baseMcpServer(contribution, config);
  const bearerToken = definition.bearerSecretKey
    ? requiredSecret(secrets, businessPluginId, definition.bearerSecretKey)
    : '';
  if (bearerToken) {
    try {
      validateHeaderValue('Authorization', `Bearer ${bearerToken.trim()}`);
    } catch (error) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_SECRET_UNAVAILABLE',
        `业务插件 ${businessPluginId} 的 MCP ${definition.id} bearer Secret 不是有效的 HTTP Header 值`,
        { cause: error },
      );
    }
  }
  const headers = definition.headers.map((header) => ({
    name: header.name,
    value: header.secretKey
      ? requiredSecret(secrets, businessPluginId, header.secretKey)
      : header.value ?? '',
  }));
  for (const header of headers) {
    try {
      validateHeaderValue(header.name, header.value);
    } catch (error) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_SECRET_UNAVAILABLE',
        `业务插件 ${businessPluginId} 的 MCP ${definition.id} header ${header.name} 值无效`,
        { cause: error },
      );
    }
  }
  return {
    ...server,
    bearerToken,
    headers,
  };
}

export class BusinessPluginRuntimeService {
  private readonly manager = new CordisRuntimeManager();
  private readonly registered = new Set<string>();

  async startRun(input: BusinessPluginRuntimeInput): Promise<BusinessPluginRunHandle> {
    const candidates = new Map(input.definitions.map((definition) => [definition.manifest.id, definition]));
    const selections = input.lock.plugins.map((plugin) => ({
      id: businessPluginId(plugin.id),
      contentHash: plugin.contentHash,
    }));
    const definitions = await Promise.all(selections.map((selection) => materializePlugin(
      input.workspaceRoot,
      selection.id,
      selection.contentHash,
      candidates.get(selection.id),
    )));

    for (const definition of definitions) {
      const key = `${definition.manifest.id}\u0000${definition.contentHash}`;
      if (this.registered.has(key)) continue;
      this.manager.registerPlugin(createBusinessPluginCordisDefinition(definition));
      this.registered.add(key);
    }
    const runtime = await this.manager.startRun(input.runId, input.lock);

    try {
      const definitionsById = new Map(definitions.map((item) => [item.manifest.id, item]));
      const skills = await Promise.all(runtime.catalog.skills.map(async (contribution) => {
        const value = contribution.value as SkillContributionValue;
        const plugin = definitionsById.get(value.businessPluginId);
        if (!plugin) throw new Error(`Cordis catalog 引用了未选择的业务插件：${value.businessPluginId}`);
        const root = resolve(plugin.root, value.definition.path);
        return readSkillIndexItem(
          root,
          'business',
          true,
          `business:${value.businessPluginId}/${value.definition.id}`,
          value.definition.id,
        );
      }));
      const refreshMcpServers = async () => {
        if (!runtime.catalog.mcpServers.length) return [];
        // 一次刷新只读取一次 tenant Secret 快照，避免一个 MCP 调用按 key 重复访问数据库，
        // 也避免同次装配混用管理员更新前后的两组值。
        const secretKeys = [...new Set(runtime.catalog.mcpServers.flatMap((contribution) => {
          const value = contribution.value as McpContributionValue;
          return [
            value.definition.bearerSecretKey,
            ...value.definition.headers.map((header) => header.secretKey),
          ].filter((key): key is string => Boolean(key));
        }))];
        const secrets = await input.resolveSecrets?.(input.lock.tenantId, secretKeys) ?? {};
        return Promise.all(runtime.catalog.mcpServers.map((contribution) => {
          const value = contribution.value as McpContributionValue;
          return resolveMcpServer(
            value,
            input.tenantConfig?.[value.businessPluginId] ?? {},
            secrets,
          );
        }));
      };
      // 初始目录只需要 ID/说明和非敏感 endpoint；Secret 到激活或真实调用前才读取。
      const mcpServers = runtime.catalog.mcpServers.map((contribution) => {
        const value = contribution.value as McpContributionValue;
        return baseMcpServer(value, input.tenantConfig?.[value.businessPluginId] ?? {});
      });
      let disposed = false;
      return {
        skills,
        mcpServers,
        refreshMcpServers,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await runtime.dispose();
        },
      };
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.manager.dispose();
  }
}

function businessPluginId(runtimePluginId: string): string {
  if (!runtimePluginId.startsWith('business.')) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_NOT_READY', `运行锁包含非业务插件：${runtimePluginId}`);
  }
  return runtimePluginId.slice('business.'.length);
}

export const businessPluginRuntime = new BusinessPluginRuntimeService();
