import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  LlmInputModality,
  LlmModelCapabilitySettings,
  LlmModelCapabilitySource,
  LlmModelOption,
  LlmProviderSettings,
  LlmProtocol,
  LlmSettings,
  McpHeaderSettings,
  McpServerSettings,
  McpSettings,
  RuntimeImageCapabilityModel,
  RuntimeLlmCapabilityModel,
  RuntimeVideoCapabilityModel,
  RuntimeCapabilitiesSettings,
  SandboxBackendName,
  TenantResourceAuthorization,
  ToolSettings,
} from '@runforge/contracts';
export type { LlmModelOption, LlmProviderSettings, LlmSettings, McpServerSettings, McpSettings, RuntimeCapabilitiesSettings, ToolSettings } from '@runforge/contracts';
import { config } from './config.js';
import type { Scope, TenantScope } from './store/types.js';
import { findSetting, findSettings, insertMissingSettings, upsertSettings } from './store/settingsRepository.js';
import { resolveWorkspaceRoot } from './files/workspaceRoot.js';
import { catalogCapability } from './llm/modelCatalog.js';

export const SYSTEM_RESOURCE_TENANT_ID = 'default';

type SettingRow = { key: string; value: unknown };
const PAGE_STATE_KEY = 'ui.pageState';
const LLM_SETTINGS_KEY = 'llm.settings';
const MCP_SETTINGS_KEY = 'mcp.settings';
const RUNTIME_CAPABILITIES_SETTINGS_KEY = 'runtimeCapabilities.settings';
const TENANT_RESOURCE_AUTHORIZATION_KEY = 'tenant.resourceAuthorization';
const MAX_PAGE_STATE_BYTES = 200_000;

const TOOL_SETTING_KEYS = [
  'tools.sandbox',
  'tools.sandboxBackend',
  'tools.workspaceRoot',
  'tools.shellEnabled',
  'tools.shellUseHostPath',
  'tools.shellPathMode',
  'tools.shellPath',
  'tools.shellAllowCommands',
  'tools.network',
  'tools.shellDeny',
  'tools.maxOutput',
] as const;

const warned = new Set<string>();
const MAX_TOOL_OUTPUT_CHARS = 40_000;

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function outputLimitValue(value: unknown, fallback: number): number {
  const raw = Math.floor(numberValue(value, fallback));
  return Math.min(MAX_TOOL_OUTPUT_CHARS, Math.max(1000, raw));
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function sandboxValue(value: unknown, fallback: ToolSettings['sandbox']): ToolSettings['sandbox'] {
  return value === 'enforce' || value === 'off' ? value : fallback;
}

function backendValue(value: unknown, fallback: SandboxBackendName): SandboxBackendName {
  return value === 'auto' || value === 'none' || value === 'bwrap' ? value : fallback;
}

function networkValue(value: unknown, fallback: ToolSettings['network']): ToolSettings['network'] {
  return value === 'enabled' || value === 'disabled' ? value : fallback;
}

function shellPathModeValue(value: unknown, fallback: ToolSettings['shellPathMode']): ToolSettings['shellPathMode'] {
  return value === 'system' || value === 'custom' ? value : fallback;
}

function llmProtocolValue(body: Record<string, unknown>, fallback: LlmProtocol): LlmProtocol {
  if (body.protocol === 'openai-responses' || body.protocol === 'openai-chat' || body.protocol === 'anthropic-messages') {
    return body.protocol;
  }
  if (body.protocol !== undefined) throw new Error(`不支持的 LLM 协议：${String(body.protocol)}`);

  const legacyProvider = body.provider;
  if (legacyProvider === undefined) return fallback;
  if (legacyProvider === 'openai-responses') return 'openai-responses';
  if (legacyProvider === 'openai-chat') return 'openai-chat';
  if (legacyProvider === 'anthropic') return 'anthropic-messages';
  if (legacyProvider === 'aisdk') {
    if (body.aisdkFlavor === 'openai') return 'openai-responses';
    if (body.aisdkFlavor === 'anthropic') return 'anthropic-messages';
    if (body.aisdkFlavor === 'openai-compatible' || body.aisdkFlavor === undefined) return 'openai-chat';
  }
  throw new Error(`旧 LLM 配置无法转换为受支持协议：${String(legacyProvider)}`);
}

function providerIdValue(value: unknown, fallback: string): string {
  const id = stringValue(value, fallback);
  if (id.includes(':')) return fallback;
  return id;
}

function positiveIntValue(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Math.floor(numberValue(value, fallback));
  return Math.min(max, Math.max(min, raw));
}

function optionalPositiveIntValue(value: unknown, fallback: number | null, min: number, max: number): number | null {
  if (value === null || value === '') return null;
  if (value === undefined || typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function uniqStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function llmModalities(value: unknown, fallback: LlmInputModality[]): LlmInputModality[] {
  if (!Array.isArray(value)) return fallback;
  const allowed = new Set<LlmInputModality>(['text', 'image', 'audio', 'video', 'document']);
  const normalized = value.map((item) => String(item).trim()).filter((item): item is LlmInputModality => allowed.has(item as LlmInputModality));
  return [...new Set<LlmInputModality>(normalized)];
}

function normalizeLlmModelCapabilities(
  value: unknown,
  models: string[],
  fallback: LlmModelCapabilitySettings[] = [],
): LlmModelCapabilitySettings[] {
  const rows = Array.isArray(value) ? value : [];
  const rowByModel = new Map(rows.flatMap((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const model = typeof row.model === 'string' ? row.model.trim() : '';
    return model ? [[model, row] as const] : [];
  }));
  const fallbackByModel = new Map(fallback.map((item) => [item.model, item]));
  return models.map((model) => {
    const catalog = catalogCapability(model);
    const inherited = fallbackByModel.get(model);
    const row = rowByModel.get(model);
    const contextSource = llmCapabilitySource(row?.contextWindowSource ?? inherited?.contextWindowSource);
    const compactionSource = llmCapabilitySource(row?.compactionThresholdSource ?? inherited?.compactionThresholdSource);
    const modalitiesSource = llmCapabilitySource(row?.inputModalitiesSource ?? inherited?.inputModalitiesSource);
    const manualContext = contextSource === 'manual'
      ? optionalPositiveIntValue(row?.contextWindow ?? inherited?.contextWindow, null, 1, 10_000_000)
      : null;
    const manualCompactionThreshold = compactionSource === 'manual'
      ? optionalPositiveIntValue(row?.compactionThreshold ?? inherited?.compactionThreshold, null, 1, 10_000_000)
      : null;
    const manualModalities = modalitiesSource === 'manual'
      ? llmModalities(row?.inputModalities ?? inherited?.inputModalities, [])
      : [];
    const contextWindowSource = manualContext !== null ? 'manual' : catalog.contextWindowSource;
    const compactionThresholdSource = manualCompactionThreshold !== null ? 'manual' : catalog.compactionThresholdSource;
    const inputModalitiesSource = manualModalities.length ? 'manual' : catalog.inputModalitiesSource;
    const catalogFields = new Set([
      ...(contextWindowSource === 'catalog' ? ['contextWindow' as const] : []),
      ...(inputModalitiesSource === 'catalog' ? ['inputModalities' as const] : []),
    ]);
    return {
      model,
      contextWindow: manualContext ?? catalog.contextWindow,
      contextWindowSource,
      compactionThreshold: manualCompactionThreshold ?? catalog.compactionThreshold,
      compactionThresholdSource,
      inputModalities: manualModalities.length ? manualModalities : catalog.inputModalities,
      inputModalitiesSource,
      references: catalog.references.flatMap((reference) => {
        const fields = reference.fields.filter((field) => catalogFields.has(field));
        return fields.length ? [{ ...reference, fields }] : [];
      }),
    };
  });
}

function llmCapabilitySource(value: unknown): LlmModelCapabilitySource | null {
  return value === 'catalog' || value === 'manual' ? value : null;
}

function keyValueList(value: unknown): McpHeaderSettings[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const value = typeof row.value === 'string' ? row.value : '';
      return name ? { name, value } : null;
    })
    .filter((item): item is McpHeaderSettings => Boolean(item));
}

function mcpServerIdValue(value: unknown, fallback: string): string {
  const raw = stringValue(value, fallback)
    .replace(/[^0-9A-Za-z_.-]/g, '-')
    .replace(/_{2,}/g, '-');
  return raw || fallback;
}

function runtimeModelIdValue(value: unknown, fallback: string): string {
  const raw = stringValue(value, fallback)
    .replace(/[^0-9A-Za-z_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || fallback;
}

function defaultToolSettings(): ToolSettings {
  return {
    sandbox: config.tools.sandbox,
    sandboxBackend: config.tools.sandboxBackend,
    workspaceRoot: config.tools.workspaceRoot,
    shellEnabled: config.tools.shellEnabled,
    shellUseHostPath: config.tools.shellUseHostPath,
    shellPathMode: config.tools.shellPathMode,
    shellPath: config.tools.shellPath,
    shellAllowCommands: config.tools.shellAllowCommands,
    network: config.tools.network,
    shellDeny: config.tools.shellDeny,
    maxOutput: config.tools.maxOutput,
  };
}

function modelRef(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

function defaultLlmProviderSettings(): LlmProviderSettings {
  const defaultModel = stringValue(config.llm.model, 'gpt-4o-mini');
  return {
    id: 'default',
    label: '默认供应商',
    protocol: config.llm.protocol,
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    discoveredModels: [defaultModel],
    models: [defaultModel],
    modelCapabilities: [catalogCapability(defaultModel)],
    defaultModel,
    timeoutMs: positiveIntValue(config.llm.timeoutMs, 120_000, 1000, 600_000),
    retries: positiveIntValue(config.llm.retries, 2, 0, 10),
  };
}

function defaultLlmSettings(): LlmSettings {
  const provider = defaultLlmProviderSettings();
  return {
    defaultModelRef: modelRef(provider.id, provider.defaultModel),
    providers: [provider],
  };
}

function defaultMcpSettings(): McpSettings {
  return { servers: [] };
}

function defaultRuntimeCapabilitiesSettings(): RuntimeCapabilitiesSettings {
  return {
    llm: { enabled: false, defaultModelId: '', models: [] },
    image: {
      enabled: false,
      defaultModelId: '',
      models: [],
    },
    video: { enabled: false, defaultModelId: '', models: [] },
  };
}

/** 新 tenant 只创建自己的授权记录。系统资源统一由系统设置维护，不复制进 tenant。 */
export function tenantSettingsTemplateEntries(): Array<{ key: string; value: unknown }> {
  return [
    {
      key: TENANT_RESOURCE_AUTHORIZATION_KEY,
      value: { llmProviderIds: [], datasourceIds: [] } satisfies TenantResourceAuthorization,
    },
  ];
}

function rowsToMap(rows: SettingRow[]): Map<string, unknown> {
  return new Map(rows.map((row) => [row.key, row.value]));
}

function mergeToolSettings(values: Map<string, unknown>): ToolSettings {
  const defaults = defaultToolSettings();
  return {
    sandbox: sandboxValue(values.get('tools.sandbox'), defaults.sandbox),
    sandboxBackend: backendValue(values.get('tools.sandboxBackend'), defaults.sandboxBackend),
    workspaceRoot: resolve(stringValue(values.get('tools.workspaceRoot'), defaults.workspaceRoot)),
    shellEnabled: boolValue(values.get('tools.shellEnabled'), defaults.shellEnabled),
    shellUseHostPath: boolValue(values.get('tools.shellUseHostPath'), defaults.shellUseHostPath),
    shellPathMode: shellPathModeValue(values.get('tools.shellPathMode'), defaults.shellPathMode),
    shellPath: stringValue(values.get('tools.shellPath'), defaults.shellPath),
    shellAllowCommands: stringList(values.get('tools.shellAllowCommands'), defaults.shellAllowCommands),
    network: networkValue(values.get('tools.network'), defaults.network),
    shellDeny: stringList(values.get('tools.shellDeny'), defaults.shellDeny),
    maxOutput: outputLimitValue(values.get('tools.maxOutput'), defaults.maxOutput),
  };
}

async function bindWorkspaceRoot(settings: ToolSettings, scope: TenantScope | Scope): Promise<ToolSettings> {
  // 工具、文件列表和 shell 都依赖 workspaceRoot 已存在；在统一入口创建可避免各工具重复兜底。
  const workspaceRoot = resolveWorkspaceRoot(scope, settings.workspaceRoot);
  await mkdir(workspaceRoot, { recursive: true });
  return { ...settings, workspaceRoot };
}

async function readSettingRows(tenantId: string, keys: readonly string[]): Promise<SettingRow[]> {
  return findSettings(tenantId, keys);
}

/** 系统工具设置缺项时,用启动配置补齐系统资源记录。 */
async function insertMissingDefaults(rows: SettingRow[]): Promise<void> {
  const existing = new Set(rows.map((row) => row.key));
  const missing = toolSettingsToEntries(defaultToolSettings())
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => ({ key, value }));
  await insertMissingSettings(SYSTEM_RESOURCE_TENANT_ID, missing);
}

/** 读取系统统一维护的工具策略和 workspace 基础目录。 */
export async function getSystemToolSettings(): Promise<ToolSettings> {
  try {
    const systemRows = await readSettingRows(SYSTEM_RESOURCE_TENANT_ID, TOOL_SETTING_KEYS);
    if (systemRows.length < TOOL_SETTING_KEYS.length) await insertMissingDefaults(systemRows);
    const mergedMap = rowsToMap(await readSettingRows(SYSTEM_RESOURCE_TENANT_ID, TOOL_SETTING_KEYS));
    return mergeToolSettings(mergedMap);
  } catch (err) {
    warnOnce('settings-fallback', `Tool settings fallback to env defaults: ${(err as Error).message}`);
    return defaultToolSettings();
  }
}

/** 工具执行策略由系统统一维护；workspaceRoot 根据当前 tenant/user 从系统基础目录派生。 */
export async function getToolSettings(scope: TenantScope | Scope): Promise<ToolSettings> {
  return bindWorkspaceRoot(await getSystemToolSettings(), scope);
}

function toolSettingsToEntries(settings: ToolSettings): Array<[string, unknown]> {
  return [
    ['tools.sandbox', settings.sandbox],
    ['tools.sandboxBackend', settings.sandboxBackend],
    ['tools.workspaceRoot', settings.workspaceRoot],
    ['tools.shellEnabled', settings.shellEnabled],
    ['tools.shellUseHostPath', settings.shellUseHostPath],
    ['tools.shellPathMode', settings.shellPathMode],
    ['tools.shellPath', settings.shellPath],
    ['tools.shellAllowCommands', settings.shellAllowCommands],
    ['tools.network', settings.network],
    ['tools.shellDeny', settings.shellDeny],
    ['tools.maxOutput', settings.maxOutput],
  ];
}

export function normalizeToolSettings(input: unknown): ToolSettings {
  const values = new Map<string, unknown>();
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(body)) {
    values.set(`tools.${key}`, value);
  }
  return mergeToolSettings(values);
}

export function shellPathForSettings(settings: ToolSettings): string {
  return settings.shellPathMode === 'custom' ? settings.shellPath : process.env.PATH ?? '';
}

export async function saveToolSettings(scope: TenantScope, input: unknown): Promise<ToolSettings> {
  if (scope.tenantId !== SYSTEM_RESOURCE_TENANT_ID) throw new Error('工具设置只能由系统管理员修改');
  const settings = normalizeToolSettings(input);
  await upsertSettings(scope.tenantId, toolSettingsToEntries(settings).map(([key, value]) => ({ key, value })));
  await mkdir(settings.workspaceRoot, { recursive: true });
  return settings;
}

function normalizeMcpServer(input: unknown, fallback: McpServerSettings, usedIds: Set<string>): McpServerSettings {
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawId = mcpServerIdValue(body.id, fallback.id);
  let id = rawId;
  for (let i = 2; usedIds.has(id); i += 1) id = `${rawId}-${i}`;
  usedIds.add(id);
  const label = stringValue(body.label, fallback.label || id);
  return {
    id,
    label,
    // 旧配置没有 description 时先用显示名称路由，管理员后续可补成更准确的能力描述。
    description: stringValue(body.description, label),
    enabled: boolValue(body.enabled, fallback.enabled),
    url: stringValue(body.url, fallback.url),
    bearerToken: typeof body.bearerToken === 'string' ? body.bearerToken : fallback.bearerToken,
    headers: keyValueList(body.headers),
    timeoutMs: positiveIntValue(body.timeoutMs, fallback.timeoutMs, 1000, 600_000),
    maxOutput: outputLimitValue(body.maxOutput, fallback.maxOutput),
  };
}

export function normalizeMcpSettings(input: unknown): McpSettings {
  const defaults = defaultMcpSettings();
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawServers = Array.isArray(body.servers) ? body.servers : defaults.servers;
  const usedIds = new Set<string>();
  const fallback: McpServerSettings = {
    id: 'mcp',
    label: 'MCP Server',
    description: '外部 MCP Server 提供的能力。',
    enabled: false,
    url: '',
    bearerToken: '',
    headers: [],
    timeoutMs: 60_000,
    maxOutput: 40_000,
  };
  return {
    servers: rawServers.map((server, index) => normalizeMcpServer(server, { ...fallback, id: `mcp-${index + 1}` }, usedIds)),
  };
}

async function readTenantJsonSetting(tenantId: string, key: string): Promise<unknown> {
  return findSetting(tenantId, key);
}

async function upsertTenantJsonSetting(tenantId: string, key: string, value: unknown): Promise<void> {
  await upsertSettings(tenantId, [{ key, value }]);
}

export function normalizeTenantResourceAuthorization(input: unknown): TenantResourceAuthorization {
  const body = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    llmProviderIds: uniqStrings(stringList(body.llmProviderIds, [])),
    datasourceIds: uniqStrings(stringList(body.datasourceIds, [])),
  };
}

export async function getTenantResourceAuthorization(tenantId: string): Promise<TenantResourceAuthorization> {
  return normalizeTenantResourceAuthorization(
    await readTenantJsonSetting(tenantId, TENANT_RESOURCE_AUTHORIZATION_KEY),
  );
}

export async function saveTenantResourceAuthorization(
  tenantId: string,
  input: unknown,
): Promise<TenantResourceAuthorization> {
  const authorization = normalizeTenantResourceAuthorization(input);
  await upsertTenantJsonSetting(tenantId, TENANT_RESOURCE_AUTHORIZATION_KEY, authorization);
  return authorization;
}

export async function getSystemMcpSettings(): Promise<McpSettings> {
  try {
    const value = await readTenantJsonSetting(SYSTEM_RESOURCE_TENANT_ID, MCP_SETTINGS_KEY);
    if (value === undefined) {
      const defaults = defaultMcpSettings();
      await insertMissingSettings(SYSTEM_RESOURCE_TENANT_ID, [{ key: MCP_SETTINGS_KEY, value: defaults }]);
      return defaults;
    }
    return normalizeMcpSettings(value);
  } catch (err) {
    warnOnce('mcp-settings-fallback', `MCP settings fallback to empty defaults: ${(err as Error).message}`);
    return defaultMcpSettings();
  }
}

export async function saveMcpSettings(scope: TenantScope, input: unknown): Promise<McpSettings> {
  if (scope.tenantId !== SYSTEM_RESOURCE_TENANT_ID) throw new Error('MCP 设置只能由系统管理员修改');
  const settings = normalizeMcpSettings(input);
  await upsertTenantJsonSetting(scope.tenantId, MCP_SETTINGS_KEY, settings);
  return settings;
}

function normalizeLlmProvider(input: unknown, fallback: LlmProviderSettings, usedIds: Set<string>): LlmProviderSettings {
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawId = providerIdValue(body.id, fallback.id);
  let id = rawId;
  for (let i = 2; usedIds.has(id); i += 1) id = `${rawId}-${i}`;
  usedIds.add(id);

  const fallbackModels = fallback.models.length ? fallback.models : [];
  const models = uniqStrings(stringList(body.models, fallbackModels));
  const discoveredModels = uniqStrings(stringList(body.discoveredModels, [...fallback.discoveredModels, ...models]));
  const allDiscoveredModels = uniqStrings([...discoveredModels, ...models]);
  const modelCapabilities = normalizeLlmModelCapabilities(
    body.modelCapabilities,
    models,
    fallback.modelCapabilities,
  );
  const requestedDefaultModel = typeof body.defaultModel === 'string' && body.defaultModel.trim() ? body.defaultModel.trim() : fallback.defaultModel;
  const defaultModel = models.includes(requestedDefaultModel) ? requestedDefaultModel : models[0] ?? '';

  return {
    id,
    label: stringValue(body.label, fallback.label || id),
    protocol: llmProtocolValue(body, fallback.protocol),
    baseUrl: stringValue(body.baseUrl, fallback.baseUrl),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : fallback.apiKey,
    discoveredModels: allDiscoveredModels,
    models,
    modelCapabilities,
    defaultModel,
    timeoutMs: positiveIntValue(body.timeoutMs, fallback.timeoutMs, 1000, 600_000),
    retries: positiveIntValue(body.retries, fallback.retries, 0, 10),
  };
}

export function llmModelOptions(settings: LlmSettings): LlmModelOption[] {
  return settings.providers.flatMap((provider) =>
    provider.models.filter((model) => {
      const capability = provider.modelCapabilities.find((item) => item.model === model);
      return Boolean(capability?.contextWindow && capability.compactionThreshold && capability.inputModalities.length);
    }).map((model) => ({
      ref: modelRef(provider.id, model),
      providerId: provider.id,
      providerLabel: provider.label || provider.id,
      protocol: provider.protocol,
      model,
      label: `${provider.label || provider.id} · ${model}`,
    })),
  );
}

export function normalizeLlmSettings(input: unknown): LlmSettings {
  const defaults = defaultLlmSettings();
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawProviders = Array.isArray(body.providers) ? body.providers : defaults.providers;
  const usedIds = new Set<string>();
  const providers = rawProviders
    .map((item, index) => normalizeLlmProvider(item, defaults.providers[index] ?? defaultLlmProviderSettings(), usedIds))
    .filter((provider) => provider.id);
  const safeProviders = providers.length ? providers : defaults.providers;
  const options = llmModelOptions({ providers: safeProviders, defaultModelRef: defaults.defaultModelRef });
  const requestedDefault = typeof body.defaultModelRef === 'string' ? body.defaultModelRef.trim() : defaults.defaultModelRef;
  const defaultModelRef = options.some((option) => option.ref === requestedDefault) ? requestedDefault : options[0]?.ref ?? '';
  return { defaultModelRef, providers: safeProviders };
}

export async function getSystemLlmSettings(): Promise<LlmSettings> {
  const value = await readTenantJsonSetting(SYSTEM_RESOURCE_TENANT_ID, LLM_SETTINGS_KEY);
  if (value === undefined) {
    const defaults = defaultLlmSettings();
    await insertMissingSettings(SYSTEM_RESOURCE_TENANT_ID, [{ key: LLM_SETTINGS_KEY, value: defaults }]);
    return defaults;
  }
  return normalizeLlmSettings(value);
}

export async function getLlmSettings(scope: TenantScope): Promise<LlmSettings> {
  const [settings, authorization] = await Promise.all([
    getSystemLlmSettings(),
    getTenantResourceAuthorization(scope.tenantId),
  ]);
  const allowed = new Set(authorization.llmProviderIds);
  const providers = settings.providers.filter((provider) => allowed.has(provider.id));
  const options = llmModelOptions({ providers, defaultModelRef: settings.defaultModelRef });
  const defaultModelRef = options.some((option) => option.ref === settings.defaultModelRef)
    ? settings.defaultModelRef
    : options[0]?.ref ?? '';
  return { providers, defaultModelRef };
}

export async function saveLlmSettings(scope: TenantScope, input: unknown): Promise<LlmSettings> {
  if (scope.tenantId !== SYSTEM_RESOURCE_TENANT_ID) throw new Error('LLM 设置只能由系统管理员修改');
  const settings = normalizeLlmSettings(input);
  for (const provider of settings.providers) {
    for (const capability of provider.modelCapabilities) {
      if (capability.contextWindow === null || capability.contextWindow <= 0) {
        throw new Error(`模型 ${provider.id}:${capability.model} 未填写有效的上下文长度`);
      }
      if (
        capability.compactionThreshold === null
        || capability.compactionThreshold <= 0
        || capability.compactionThreshold > capability.contextWindow
      ) {
        throw new Error(`模型 ${provider.id}:${capability.model} 未填写有效的压缩阈值，且阈值不能超过上下文长度`);
      }
      if (!capability.inputModalities.length) {
        throw new Error(`模型 ${provider.id}:${capability.model} 未选择输入类型`);
      }
    }
  }
  await upsertTenantJsonSetting(scope.tenantId, LLM_SETTINGS_KEY, settings);
  return settings;
}

export function normalizeRuntimeCapabilitiesSettings(input: unknown): RuntimeCapabilitiesSettings {
  const defaults = defaultRuntimeCapabilitiesSettings();
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const llm = body.llm && typeof body.llm === 'object' ? (body.llm as Record<string, unknown>) : {};
  const image = body.image && typeof body.image === 'object' ? (body.image as Record<string, unknown>) : {};
  const video = body.video && typeof body.video === 'object' ? (body.video as Record<string, unknown>) : {};
  const normalizeLlmModels = (): RuntimeLlmCapabilityModel[] => {
    const rows = Array.isArray(llm.models) ? llm.models : [];
    return rows.map((item, index) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const modelRef = stringValue(row.modelRef, '');
      if (!modelRef) return null;
      const id = runtimeModelIdValue(row.id, `llm-${index + 1}`);
      return {
        id,
        label: stringValue(row.label, modelRef),
        modelRef,
      };
    }).filter((item): item is RuntimeLlmCapabilityModel => Boolean(item));
  };
  const normalizeImageModels = (): RuntimeImageCapabilityModel[] => {
    const rows = Array.isArray(image.models)
      ? image.models
      : (image.baseUrl || image.apiKey || image.model)
        ? [image]
        : [];
    return rows.map((item, index) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const model = stringValue(row.model, '');
      const id = runtimeModelIdValue(row.id, `image-${index + 1}`);
      return {
        id,
        label: stringValue(row.label, model || id),
        provider: row.provider === 'packy-gpt-image-2' ? row.provider : 'packy-gpt-image-2',
        baseUrl: stringValue(row.baseUrl, 'https://cf.api.fan'),
        apiKey: typeof row.apiKey === 'string' ? row.apiKey : '',
        model: model || 'gpt-image-2',
        timeoutMs: positiveIntValue(row.timeoutMs, 180_000, 1_000, 600_000),
      };
    });
  };
  const normalizeVideoModels = (): RuntimeVideoCapabilityModel[] => {
    const rows = Array.isArray(video.models) ? video.models : [];
    return rows.map((item, index) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const model = stringValue(row.model, '');
      if (!model) return null;
      const provider = stringValue(row.provider, '');
      if (!provider) return null;
      const id = runtimeModelIdValue(row.id, `video-${index + 1}`);
      return {
        id,
        label: stringValue(row.label, `${provider}:${model}`),
        provider,
        model,
      };
    }).filter((item): item is RuntimeVideoCapabilityModel => Boolean(item));
  };
  const llmModels = normalizeLlmModels();
  const imageModels = normalizeImageModels();
  const videoModels = normalizeVideoModels();
  const defaultLlmModelId = llmModels.some((model) => model.id === llm.defaultModelId)
    ? String(llm.defaultModelId)
    : llmModels[0]?.id ?? '';
  const defaultImageModelId = imageModels.some((model) => model.id === image.defaultModelId)
    ? String(image.defaultModelId)
    : imageModels[0]?.id ?? '';
  const defaultVideoModelId = videoModels.some((model) => model.id === video.defaultModelId)
    ? String(video.defaultModelId)
    : videoModels[0]?.id ?? '';
  return {
    llm: {
      enabled: boolValue(llm.enabled, defaults.llm.enabled),
      defaultModelId: defaultLlmModelId,
      models: llmModels,
    },
    image: {
      enabled: boolValue(image.enabled, defaults.image.enabled),
      defaultModelId: defaultImageModelId,
      models: imageModels,
    },
    video: {
      enabled: boolValue(video.enabled, defaults.video.enabled),
      defaultModelId: defaultVideoModelId,
      models: videoModels,
    },
  };
}

export async function getSystemRuntimeCapabilitiesSettings(): Promise<RuntimeCapabilitiesSettings> {
  try {
    const value = await readTenantJsonSetting(SYSTEM_RESOURCE_TENANT_ID, RUNTIME_CAPABILITIES_SETTINGS_KEY);
    if (value === undefined) {
      const defaults = defaultRuntimeCapabilitiesSettings();
      await insertMissingSettings(SYSTEM_RESOURCE_TENANT_ID, [{ key: RUNTIME_CAPABILITIES_SETTINGS_KEY, value: defaults }]);
      return defaults;
    }
    return normalizeRuntimeCapabilitiesSettings(value);
  } catch (err) {
    warnOnce('runtime-capabilities-settings-fallback', `Runtime capability settings fallback to defaults: ${(err as Error).message}`);
    return defaultRuntimeCapabilitiesSettings();
  }
}

export async function getRuntimeCapabilitiesSettings(scope: TenantScope): Promise<RuntimeCapabilitiesSettings> {
  const [settings, authorization] = await Promise.all([
    getSystemRuntimeCapabilitiesSettings(),
    getTenantResourceAuthorization(scope.tenantId),
  ]);
  const allowedProviders = new Set(authorization.llmProviderIds);
  const llmModels = settings.llm.models.filter((model) => allowedProviders.has(model.modelRef.split(':', 1)[0]));
  return {
    ...settings,
    llm: {
      ...settings.llm,
      enabled: settings.llm.enabled && llmModels.length > 0,
      defaultModelId: llmModels.some((model) => model.id === settings.llm.defaultModelId)
        ? settings.llm.defaultModelId
        : llmModels[0]?.id ?? '',
      models: llmModels,
    },
  };
}

export async function saveRuntimeCapabilitiesSettings(scope: TenantScope, input: unknown): Promise<RuntimeCapabilitiesSettings> {
  if (scope.tenantId !== SYSTEM_RESOURCE_TENANT_ID) throw new Error('运行时能力设置只能由系统管理员修改');
  const settings = normalizeRuntimeCapabilitiesSettings(input);
  await upsertTenantJsonSetting(scope.tenantId, RUNTIME_CAPABILITIES_SETTINGS_KEY, settings);
  return settings;
}

function normalizePageState(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAGE_STATE_BYTES) {
    throw new Error('页面状态过大，无法保存');
  }
  return JSON.parse(json) as Record<string, unknown>;
}

// pageState 是纯 UI 状态,不是策略配置,只按本租户存取,不做 default 租户回退。
export async function getPageState(scope: TenantScope): Promise<Record<string, unknown>> {
  return normalizePageState(await findSetting(scope.tenantId, PAGE_STATE_KEY));
}

export async function savePageState(scope: TenantScope, input: unknown): Promise<Record<string, unknown>> {
  const state = normalizePageState(input);
  await upsertTenantJsonSetting(scope.tenantId, PAGE_STATE_KEY, state);
  return state;
}
