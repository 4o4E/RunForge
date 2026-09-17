import Ajv, { type ErrorObject } from 'ajv';
import { z } from 'zod';
import { findSetting, updateSettingAtomically } from '../store/settingsRepository.js';
import { BusinessPluginError } from './errors.js';
import type { BusinessPluginDefinition } from './types.js';
import type {
  BusinessPluginAdminView,
  UpdateBusinessPluginSettingsInput,
} from '@runforge/contracts';
import { businessPluginRegistry } from './registry.js';

const BUSINESS_PLUGIN_SETTINGS_KEY = 'businessPlugins.settings';
const jsonObjectSchema = z.record(z.string(), z.unknown());
const tenantSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  plugins: z.record(z.string(), z.object({ config: jsonObjectSchema.default({}) }).strict()).default({}),
  secrets: z.record(z.string(), z.string()).default({}),
}).strict();

export interface BusinessPluginTenantSettings {
  schemaVersion: 1;
  plugins: Record<string, { config: Record<string, unknown> }>;
  secrets: Record<string, string>;
}

export interface BusinessPluginReadiness {
  definition: BusinessPluginDefinition;
  ready: boolean;
  error?: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? '格式无效'}`).join('；');
}

export function normalizeBusinessPluginTenantSettings(value: unknown): BusinessPluginTenantSettings {
  const parsed = tenantSettingsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_CONFIG_INVALID',
      `${path}${issue?.message ?? 'tenant 业务插件配置格式无效'}`,
    );
  }
  return parsed.data;
}

export async function getBusinessPluginTenantSettings(tenantId: string): Promise<BusinessPluginTenantSettings> {
  return normalizeBusinessPluginTenantSettings(await findSetting(tenantId, BUSINESS_PLUGIN_SETTINGS_KEY));
}

function readinessError(
  definition: BusinessPluginDefinition,
  settings: BusinessPluginTenantSettings,
): string | undefined {
  const pluginId = definition.manifest.id;
  const pluginConfig = ownValue(settings.plugins, pluginId)?.config ?? {};
  let validate;
  if (definition.manifest.configSchema.$async === true) return 'configSchema 不支持异步校验';
  try {
    validate = ajv.compile(definition.manifest.configSchema);
  } catch (error) {
    return `configSchema 无效：${(error as Error).message}`;
  }
  const valid = validate(pluginConfig);
  if (typeof valid !== 'boolean') return 'configSchema 不支持异步校验';
  if (!valid) return `tenant 配置无效：${validationMessage(validate.errors)}`;

  for (const server of definition.manifest.mcpServers) {
    if (server.urlConfigKey) {
      const value = pluginConfig[server.urlConfigKey];
      if (typeof value !== 'string' || !value.trim()) return `MCP ${server.id} 缺少配置 ${server.urlConfigKey}`;
      try {
        const endpoint = new URL(value);
        if (!/^https?:$/.test(endpoint.protocol)) return `MCP ${server.id} 的配置 ${server.urlConfigKey} 只支持 HTTP/HTTPS URL`;
        if (endpoint.username || endpoint.password) return `MCP ${server.id} 的配置 ${server.urlConfigKey} 不能包含用户名或密码`;
      } catch {
        return `MCP ${server.id} 的配置 ${server.urlConfigKey} 不是有效 URL`;
      }
    }
  }

  const requiredKeys = new Set(
    definition.manifest.secrets.filter((secret) => secret.required).map((secret) => secret.key),
  );
  for (const server of definition.manifest.mcpServers) {
    if (server.bearerSecretKey) requiredKeys.add(server.bearerSecretKey);
    for (const header of server.headers) if (header.secretKey) requiredKeys.add(header.secretKey);
  }
  for (const key of requiredKeys) {
    if (!ownValue(settings.secrets, key)?.trim()) return `缺少 tenant Secret：${key}`;
  }
  return undefined;
}

export function businessPluginReadiness(
  definitions: readonly BusinessPluginDefinition[],
  settings: BusinessPluginTenantSettings,
): BusinessPluginReadiness[] {
  return definitions.map((definition) => {
    const error = readinessError(definition, settings);
    return { definition, ready: !error, ...(error ? { error } : {}) };
  });
}

export function tenantBusinessPluginConfig(
  settings: BusinessPluginTenantSettings,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return Object.fromEntries(Object.entries(settings.plugins).map(([id, value]) => [id, value.config]));
}

export function businessPluginAdminView(
  definitions: readonly BusinessPluginDefinition[],
  settings: BusinessPluginTenantSettings,
): BusinessPluginAdminView {
  const readiness = new Map(
    businessPluginReadiness(definitions, settings).map((item) => [item.definition.manifest.id, item]),
  );
  return {
    plugins: definitions.map((definition) => {
      const state = readiness.get(definition.manifest.id)!;
      return {
        id: definition.manifest.id,
        displayName: definition.manifest.displayName,
        description: definition.manifest.description,
        version: definition.manifest.version ?? null,
        contentHash: definition.contentHash,
        configSchema: definition.manifest.configSchema,
        config: ownValue(settings.plugins, definition.manifest.id)?.config ?? {},
        skills: definition.manifest.skills.map((skill) => ({ id: skill.id, path: skill.path })),
        mcpServers: definition.manifest.mcpServers.map((server) => ({
          id: server.id,
          label: server.label,
          description: server.description,
        })),
        resources: definition.manifest.resources.map((resource) => ({ type: resource.type })),
        secrets: definition.manifest.secrets.map((secret) => ({
          ...secret,
          configured: Boolean(ownValue(settings.secrets, secret.key)?.trim()),
        })),
        ready: state.ready,
        error: state.error ?? null,
      };
    }),
  };
}

export async function updateBusinessPluginTenantSettings(
  tenantId: string,
  definitions: readonly BusinessPluginDefinition[],
  input: UpdateBusinessPluginSettingsInput,
): Promise<BusinessPluginTenantSettings> {
  const knownPlugins = new Set(definitions.map((definition) => definition.manifest.id));
  const knownSecrets = new Set(definitions.flatMap((definition) => definition.manifest.secrets.map((secret) => secret.key)));
  return updateSettingAtomically(tenantId, BUSINESS_PLUGIN_SETTINGS_KEY, (stored) => {
    const current = normalizeBusinessPluginTenantSettings(stored);
    const plugins = structuredClone(current.plugins);
    const secrets = { ...current.secrets };

    for (const [id, value] of Object.entries(input.plugins ?? {})) {
      if (!knownPlugins.has(id)) {
        throw new BusinessPluginError('BUSINESS_PLUGIN_CONFIG_INVALID', `tenant 没有已发现的业务插件：${id}`);
      }
      const parsed = z.object({ config: jsonObjectSchema }).strict().safeParse(value);
      if (!parsed.success) {
        throw new BusinessPluginError('BUSINESS_PLUGIN_CONFIG_INVALID', `业务插件 ${id} 的 config 必须是 JSON 对象`);
      }
      setOwnValue(plugins, id, parsed.data);
    }
    for (const [key, value] of Object.entries(input.secrets ?? {})) {
      if (!knownSecrets.has(key)) {
        throw new BusinessPluginError('BUSINESS_PLUGIN_CONFIG_INVALID', `业务插件未声明 tenant Secret：${key}`);
      }
      if (value === null) delete secrets[key];
      else if (typeof value === 'string' && value.length <= 100_000) setOwnValue(secrets, key, value);
      else throw new BusinessPluginError('BUSINESS_PLUGIN_CONFIG_INVALID', `tenant Secret ${key} 格式无效`);
    }

    return { schemaVersion: 1 as const, plugins, secrets };
  });
}

export async function loadBusinessPluginAdminView(
  tenantId: string,
  reload = false,
): Promise<BusinessPluginAdminView> {
  const definitions = reload
    ? await businessPluginRegistry.reload(tenantId)
    : await businessPluginRegistry.list(tenantId);
  return businessPluginAdminView(definitions, await getBusinessPluginTenantSettings(tenantId));
}

export async function updateBusinessPluginAdminView(
  tenantId: string,
  input: UpdateBusinessPluginSettingsInput,
): Promise<BusinessPluginAdminView> {
  const definitions = await businessPluginRegistry.list(tenantId);
  const settings = await updateBusinessPluginTenantSettings(tenantId, definitions, input);
  return businessPluginAdminView(definitions, settings);
}
