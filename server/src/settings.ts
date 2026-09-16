import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  LlmAiSdkFlavor,
  LlmInputModality,
  LlmModelCapabilitySettings,
  LlmModelCapabilitySource,
  LlmModelOption,
  LlmProviderName,
  LlmProviderSettings,
  LlmSettings,
  McpHeaderSettings,
  McpServerSettings,
  McpSettings,
  RuntimeImageCapabilityModel,
  RuntimeLlmCapabilityModel,
  RuntimeVideoCapabilityModel,
  RuntimeCapabilitiesSettings,
  SandboxBackendName,
  ToolSettings,
} from '@runforge/contracts';
export type { LlmModelOption, LlmProviderSettings, LlmSettings, McpServerSettings, McpSettings, RuntimeCapabilitiesSettings, ToolSettings } from '@runforge/contracts';
import { config } from './config.js';
import type { Scope, TenantScope } from './store/types.js';
import { findSetting, findSettings, insertMissingSettings, upsertSettings } from './store/settingsRepository.js';
import { resolveWorkspaceRoot } from './files/workspaceRoot.js';
import { mergeModelCapability } from './llm/modelCatalog.js';

const DEFAULT_TENANT_ID = 'default';

type SettingRow = { key: string; value: unknown };
const PAGE_STATE_KEY = 'ui.pageState';
const LLM_SETTINGS_KEY = 'llm.settings';
const MCP_SETTINGS_KEY = 'mcp.settings';
const RUNTIME_CAPABILITIES_SETTINGS_KEY = 'runtimeCapabilities.settings';
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

function llmProviderNameValue(value: unknown, fallback: LlmProviderName): LlmProviderName {
  return value === 'aisdk' || value === 'openai-responses' || value === 'openai-chat' || value === 'anthropic' || value === 'mock'
    ? value
    : fallback;
}

function llmAiSdkFlavorValue(value: unknown, fallback: LlmAiSdkFlavor): LlmAiSdkFlavor {
  return value === 'openai-compatible' || value === 'openai' || value === 'anthropic' ? value : fallback;
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
  const allowed = new Set<LlmInputModality>(['text', 'image', 'audio', 'video']);
  const normalized = value.map((item) => String(item).trim()).filter((item): item is LlmInputModality => allowed.has(item as LlmInputModality));
  return [...new Set<LlmInputModality>(['text', ...normalized])];
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
    const inherited = fallbackByModel.get(model) ?? mergeModelCapability(model);
    const row = rowByModel.get(model);
    if (!row) return inherited;
    const contextSource = llmCapabilitySource(row.contextWindowSource);
    const modalitiesSource = llmCapabilitySource(row.inputModalitiesSource);
    return mergeModelCapability(model, {
      contextWindow: contextSource === 'manual' || contextSource === 'provider'
        ? positiveIntValue(row.contextWindow, inherited.contextWindow, 1, 10_000_000)
        : inherited.contextWindow,
      contextWindowSource: contextSource === 'manual' || contextSource === 'provider' ? contextSource : inherited.contextWindowSource,
      inputModalities: modalitiesSource === 'manual' || modalitiesSource === 'provider'
        ? llmModalities(row.inputModalities, inherited.inputModalities)
        : inherited.inputModalities,
      inputModalitiesSource: modalitiesSource === 'manual' || modalitiesSource === 'provider' ? modalitiesSource : inherited.inputModalitiesSource,
    });
  });
}

function llmCapabilitySource(value: unknown): LlmModelCapabilitySource | null {
  return value === 'provider' || value === 'catalog' || value === 'default' || value === 'manual' ? value : null;
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
  const provider = llmProviderNameValue(config.llm.provider, 'aisdk');
  const defaultModel = stringValue(config.llm.model, 'gpt-4o-mini');
  return {
    id: 'default',
    label: '默认供应商',
    provider,
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    discoveredModels: [defaultModel],
    discoveredModelCapabilities: [mergeModelCapability(defaultModel)],
    models: [defaultModel],
    modelCapabilities: [mergeModelCapability(defaultModel)],
    defaultModel,
    maxTokens: positiveIntValue(config.llm.maxTokens, 4096, 1, 200_000),
    timeoutMs: positiveIntValue(config.llm.timeoutMs, 120_000, 1000, 600_000),
    retries: positiveIntValue(config.llm.retries, 2, 0, 10),
    stream: config.llm.stream,
    aisdkFlavor: llmAiSdkFlavorValue(config.llm.aisdkFlavor, 'openai-compatible'),
    reasoningTag: typeof config.llm.reasoningTag === 'string' ? config.llm.reasoningTag : 'think',
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

/** 新 tenant 创建事务使用的静态模板。PgStore 会再用 default tenant 当前已保存的
 * 运行配置覆盖同名键，从而得到“当前系统模板”的独立副本；纯 UI 状态不在模板内。 */
export function tenantSettingsTemplateEntries(): Array<{ key: string; value: unknown }> {
  return [
    ...toolSettingsToEntries(defaultToolSettings()).map(([key, value]) => ({ key, value })),
    { key: MCP_SETTINGS_KEY, value: defaultMcpSettings() },
    { key: LLM_SETTINGS_KEY, value: defaultLlmSettings() },
    { key: RUNTIME_CAPABILITIES_SETTINGS_KEY, value: defaultRuntimeCapabilitiesSettings() },
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
  settings.workspaceRoot = resolveWorkspaceRoot(scope);
  await mkdir(settings.workspaceRoot, { recursive: true });
  return settings;
}

async function readSettingRows(tenantId: string, keys: readonly string[]): Promise<SettingRow[]> {
  return findSettings(tenantId, keys);
}

/** 只给 default 租户播种基础层默认值;其它租户没有覆盖就一路 fallback 到
 *  default 租户的值再到 env 默认值(见 getToolSettings),不自动写入具体值。 */
async function insertMissingDefaults(rows: SettingRow[]): Promise<void> {
  const existing = new Set(rows.map((row) => row.key));
  const missing = toolSettingsToEntries(defaultToolSettings())
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => ({ key, value }));
  await insertMissingSettings(DEFAULT_TENANT_ID, missing);
}

/** 读取当前租户自己的工具配置。新 tenant 在创建事务中复制完整模板；若旧数据被
 *  人工删成不完整，只回退 env 默认值，不再动态读取 default tenant，避免配置串租户。 */
export async function getToolSettings(scope: TenantScope | Scope): Promise<ToolSettings> {
  try {
    const ownRows = await readSettingRows(scope.tenantId, TOOL_SETTING_KEYS);
    let mergedMap = rowsToMap(ownRows);
    if (scope.tenantId === DEFAULT_TENANT_ID) {
      if (ownRows.length < TOOL_SETTING_KEYS.length) await insertMissingDefaults(ownRows);
      mergedMap = rowsToMap(await readSettingRows(DEFAULT_TENANT_ID, TOOL_SETTING_KEYS));
    }
    const settings = mergeToolSettings(mergedMap);
    // workspaceRoot 永远按当前身份计算,不信任 app_settings 里存的字符串。
    // 否则租户管理员能把自己的 workspaceRoot 设到别人的目录,变成真实的越权读写洞。
    // 这里必须包含 userId:同租户多用户的数据已按 userId 隔离,文件工作区也要一致。
    return await bindWorkspaceRoot(settings, scope);
  } catch (err) {
    warnOnce('settings-fallback', `Tool settings fallback to env defaults: ${(err as Error).message}`);
    const fallback = defaultToolSettings();
    return await bindWorkspaceRoot(fallback, scope);
  }
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
  const settings = normalizeToolSettings(input);
  await upsertSettings(scope.tenantId, toolSettingsToEntries(settings).map(([key, value]) => ({ key, value })));
  // 存进去的值可能被调用方 normalize 出一个不受信任的 workspaceRoot,但返回值必须是
  // 计算出来的那个——同一个理由见 getToolSettings。
  return await bindWorkspaceRoot(settings, scope);
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

export async function getMcpSettings(scope: TenantScope): Promise<McpSettings> {
  try {
    const value = await readTenantJsonSetting(scope.tenantId, MCP_SETTINGS_KEY);
    if (value === undefined) {
      const defaults = defaultMcpSettings();
      if (scope.tenantId === DEFAULT_TENANT_ID) {
        await insertMissingSettings(DEFAULT_TENANT_ID, [{ key: MCP_SETTINGS_KEY, value: defaults }]);
      }
      return defaults;
    }
    return normalizeMcpSettings(value);
  } catch (err) {
    warnOnce('mcp-settings-fallback', `MCP settings fallback to empty defaults: ${(err as Error).message}`);
    return defaultMcpSettings();
  }
}

export async function saveMcpSettings(scope: TenantScope, input: unknown): Promise<McpSettings> {
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
  const discoveredModelCapabilities = normalizeLlmModelCapabilities(
    body.discoveredModelCapabilities,
    allDiscoveredModels,
    fallback.discoveredModelCapabilities,
  );
  const modelCapabilities = normalizeLlmModelCapabilities(
    body.modelCapabilities,
    models,
    discoveredModelCapabilities,
  );
  const requestedDefaultModel = typeof body.defaultModel === 'string' && body.defaultModel.trim() ? body.defaultModel.trim() : fallback.defaultModel;
  const defaultModel = models.includes(requestedDefaultModel) ? requestedDefaultModel : models[0] ?? '';

  return {
    id,
    label: stringValue(body.label, fallback.label || id),
    provider: llmProviderNameValue(body.provider, fallback.provider),
    baseUrl: stringValue(body.baseUrl, fallback.baseUrl),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : fallback.apiKey,
    discoveredModels: allDiscoveredModels,
    discoveredModelCapabilities,
    models,
    modelCapabilities,
    defaultModel,
    maxTokens: optionalPositiveIntValue(body.maxTokens, fallback.maxTokens, 1, 200_000),
    timeoutMs: positiveIntValue(body.timeoutMs, fallback.timeoutMs, 1000, 600_000),
    retries: positiveIntValue(body.retries, fallback.retries, 0, 10),
    stream: boolValue(body.stream, fallback.stream),
    aisdkFlavor: llmAiSdkFlavorValue(body.aisdkFlavor, fallback.aisdkFlavor),
    reasoningTag: typeof body.reasoningTag === 'string' ? body.reasoningTag : fallback.reasoningTag,
  };
}

export function llmModelOptions(settings: LlmSettings): LlmModelOption[] {
  return settings.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      ref: modelRef(provider.id, model),
      providerId: provider.id,
      providerLabel: provider.label || provider.id,
      provider: provider.provider,
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

export async function getLlmSettings(scope: TenantScope): Promise<LlmSettings> {
  try {
    const value = await readTenantJsonSetting(scope.tenantId, LLM_SETTINGS_KEY);
    if (value === undefined) {
      const defaults = defaultLlmSettings();
      if (scope.tenantId === DEFAULT_TENANT_ID) {
        await insertMissingSettings(DEFAULT_TENANT_ID, [{ key: LLM_SETTINGS_KEY, value: defaults }]);
      }
      return defaults;
    }
    return normalizeLlmSettings(value);
  } catch (err) {
    warnOnce('llm-settings-fallback', `LLM settings fallback to env defaults: ${(err as Error).message}`);
    return defaultLlmSettings();
  }
}

export async function saveLlmSettings(scope: TenantScope, input: unknown): Promise<LlmSettings> {
  const settings = normalizeLlmSettings(input);
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

export async function getRuntimeCapabilitiesSettings(scope: TenantScope): Promise<RuntimeCapabilitiesSettings> {
  try {
    const value = await readTenantJsonSetting(scope.tenantId, RUNTIME_CAPABILITIES_SETTINGS_KEY);
    if (value === undefined) {
      const defaults = defaultRuntimeCapabilitiesSettings();
      if (scope.tenantId === DEFAULT_TENANT_ID) {
        await insertMissingSettings(DEFAULT_TENANT_ID, [{ key: RUNTIME_CAPABILITIES_SETTINGS_KEY, value: defaults }]);
      }
      return defaults;
    }
    return normalizeRuntimeCapabilitiesSettings(value);
  } catch (err) {
    warnOnce('runtime-capabilities-settings-fallback', `Runtime capability settings fallback to defaults: ${(err as Error).message}`);
    return defaultRuntimeCapabilitiesSettings();
  }
}

export async function saveRuntimeCapabilitiesSettings(scope: TenantScope, input: unknown): Promise<RuntimeCapabilitiesSettings> {
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
