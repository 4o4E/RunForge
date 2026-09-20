import Ajv, { type ErrorObject } from 'ajv';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { store } from '../store/index.js';
import { requiredJson } from '../store/prismaRows.js';
import { findSetting, updateSettingAtomically } from '../store/settingsRepository.js';
import { probeMcpServer } from '../mcp/client.js';
import { BusinessPluginError } from './errors.js';
import type { BusinessPluginDefinition } from './types.js';
import type {
  BusinessPluginAdminView,
  BusinessPluginImportResponse,
  BusinessPluginMcpToolsView,
  BusinessPluginUninstallResponse,
  UpdateBusinessPluginSettingsInput,
} from '@runforge/contracts';
import { businessPluginRegistry } from './registry.js';
import type { BusinessPluginArchiveFormat } from './archive.js';
import { resolveBusinessPluginMcpServer } from './runtime.js';

const BUSINESS_PLUGIN_SETTINGS_KEY = 'businessPlugins.settings';
const useMemory = process.env.STORE === 'memory';
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

interface AffectedSpace {
  id: string;
  name: string;
}

interface RemovedBusinessPluginTenantState {
  affectedSpaces: AffectedSpace[];
  settings: BusinessPluginTenantSettings;
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
        skills: definition.skillEntries,
        mcpServers: definition.manifest.mcpServers.map((server) => ({
          id: server.id,
          label: server.label,
          description: server.description,
          transport: server.transport,
          url: server.url ?? null,
          urlConfigKey: server.urlConfigKey ?? null,
          bearerSecretKey: server.bearerSecretKey ?? null,
          headers: server.headers.map((header) => ({
            name: header.name,
            value: header.value ?? null,
            secretKey: header.secretKey ?? null,
          })),
          timeoutMs: server.timeoutMs,
          maxOutput: server.maxOutput,
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

export async function loadBusinessPluginMcpTools(
  tenantId: string,
  pluginId: string,
  serverId: string,
): Promise<BusinessPluginMcpToolsView> {
  const [definitions, settings] = await Promise.all([
    businessPluginRegistry.list(tenantId),
    getBusinessPluginTenantSettings(tenantId),
  ]);
  const definition = definitions.find((item) => item.manifest.id === pluginId);
  if (!definition) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_NOT_READY', `业务插件不存在：${pluginId}`);
  }
  const config = ownValue(settings.plugins, pluginId)?.config ?? {};
  const server = resolveBusinessPluginMcpServer(definition, serverId, config, settings.secrets);
  try {
    const tools = await probeMcpServer(server);
    return {
      tools: tools.map((tool) => ({
        name: tool.originalName,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    };
  } catch (error) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_NOT_READY',
      `无法读取业务插件 ${pluginId} 的 MCP ${serverId} 工具：${(error as Error).message}`,
      { cause: error },
    );
  }
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
  return businessPluginRegistry.mutateTenant(tenantId, async () => {
    const definitions = await businessPluginRegistry.list(tenantId);
    const settings = await updateBusinessPluginTenantSettings(tenantId, definitions, input);
    return businessPluginAdminView(definitions, settings);
  });
}

export async function importBusinessPluginAdminView(
  tenantId: string,
  archive: Buffer,
  format: BusinessPluginArchiveFormat,
): Promise<BusinessPluginImportResponse> {
  const imported = await businessPluginRegistry.importArchive(tenantId, archive, format);
  return {
    pluginId: imported.definition.manifest.id,
    replaced: imported.replaced,
    view: businessPluginAdminView(
      await businessPluginRegistry.list(tenantId),
      await getBusinessPluginTenantSettings(tenantId),
    ),
  };
}

function withoutPluginConfig(
  settings: BusinessPluginTenantSettings,
  pluginId: string,
): BusinessPluginTenantSettings {
  const plugins = structuredClone(settings.plugins);
  delete plugins[pluginId];
  return { schemaVersion: 1, plugins, secrets: { ...settings.secrets } };
}

function spaceConfigWithoutPlugin(config: unknown, pluginId: string): Record<string, unknown> | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_CONFIG_INVALID', '空间配置必须是 JSON 对象');
  }
  const current = config as Record<string, unknown>;
  const capabilitiesValue = current.capabilities;
  if (capabilitiesValue === undefined) return null;
  if (!capabilitiesValue || typeof capabilitiesValue !== 'object' || Array.isArray(capabilitiesValue)) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_CONFIG_INVALID', '空间 capabilities 配置必须是 JSON 对象');
  }
  const capabilities = capabilitiesValue as Record<string, unknown>;
  const pluginsValue = capabilities.businessPlugins;
  if (pluginsValue === undefined) return null;
  if (!Array.isArray(pluginsValue) || pluginsValue.some((id) => typeof id !== 'string')) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_CONFIG_INVALID', '空间 businessPlugins 配置必须是字符串数组');
  }
  if (!pluginsValue.includes(pluginId)) return null;
  return {
    ...current,
    capabilities: {
      ...capabilities,
      businessPlugins: pluginsValue.filter((id) => id !== pluginId),
    },
  };
}

async function removeBusinessPluginTenantState(
  tenantId: string,
  pluginId: string,
): Promise<RemovedBusinessPluginTenantState> {
  if (useMemory) {
    const spaces = await store.listSpaces(tenantId);
    const updates = spaces.flatMap((space) => {
      const config = spaceConfigWithoutPlugin(space.config, pluginId);
      return config ? [{ space, config }] : [];
    });
    const settings = await updateSettingAtomically(tenantId, BUSINESS_PLUGIN_SETTINGS_KEY, (stored) => (
      withoutPluginConfig(normalizeBusinessPluginTenantSettings(stored), pluginId)
    ));
    for (const { space, config } of updates) {
      const updated = await store.updateSpace(tenantId, space.id, { config });
      if (!updated) throw new Error(`更新空间 ${space.id} 的业务插件配置失败`);
    }
    return {
      affectedSpaces: updates.map(({ space }) => ({ id: space.id, name: space.name })),
      settings,
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const [stored, spaces] = await Promise.all([
          tx.app_settings.findUnique({
            where: { tenant_id_key: { tenant_id: tenantId, key: BUSINESS_PLUGIN_SETTINGS_KEY } },
            select: { value: true },
          }),
          tx.spaces.findMany({
            where: { tenant_id: tenantId, deleted_at: null },
            select: { id: true, name: true, config: true },
            orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          }),
        ]);
        const updates = spaces.flatMap((space) => {
          const config = spaceConfigWithoutPlugin(space.config, pluginId);
          return config ? [{ space, config }] : [];
        });
        const settings = withoutPluginConfig(normalizeBusinessPluginTenantSettings(stored?.value), pluginId);
        await tx.app_settings.upsert({
          where: { tenant_id_key: { tenant_id: tenantId, key: BUSINESS_PLUGIN_SETTINGS_KEY } },
          create: { tenant_id: tenantId, key: BUSINESS_PLUGIN_SETTINGS_KEY, value: requiredJson(settings) },
          update: { value: requiredJson(settings), updated_at: new Date() },
        });
        for (const { space, config } of updates) {
          await tx.spaces.update({
            where: { id: space.id },
            data: { config: requiredJson(config), config_version: { increment: 1 }, updated_at: new Date() },
          });
        }
        return {
          affectedSpaces: updates.map(({ space }) => ({ id: space.id, name: space.name })),
          settings,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
      if (attempt === 2 || (code !== 'P2034' && code !== 'P2002')) throw error;
    }
  }
  throw new Error('业务插件卸载配置并发更新重试耗尽');
}

export async function uninstallBusinessPluginAdminView(
  tenantId: string,
  pluginId: string,
): Promise<BusinessPluginUninstallResponse> {
  const result = await businessPluginRegistry.uninstall(
    tenantId,
    pluginId,
    async (_definition, definitions) => ({
      definitions,
      removedState: await removeBusinessPluginTenantState(tenantId, pluginId),
    }),
  );
  if (!result) throw new Error(`业务插件 ${pluginId} 卸载结果缺失`);
  return {
    pluginId,
    affectedSpaces: result.removedState.affectedSpaces,
    view: businessPluginAdminView(
      result.definitions.filter((definition) => definition.manifest.id !== pluginId),
      result.removedState.settings,
    ),
  };
}
