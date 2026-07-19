import { resolve } from 'node:path';
import type {
  LlmAiSdkFlavor,
  LlmModelOption,
  LlmProviderName,
  LlmProviderSettings,
  LlmSettings,
  McpHeaderSettings,
  McpServerSettings,
  McpSettings,
  SandboxBackendName,
  ToolSettings,
} from '@runforge/contracts';
export type { LlmModelOption, LlmProviderSettings, LlmSettings, McpServerSettings, McpSettings, ToolSettings } from '@runforge/contracts';
import { config } from './config.js';
import { query } from './db/pool.js';
import type { TenantScope } from './store/types.js';
import { resolveWorkspaceRoot } from './files/workspaceRoot.js';

const DEFAULT_TENANT_ID = 'default';

type SettingRow = { key: string; value: unknown };
const PAGE_STATE_KEY = 'ui.pageState';
const LLM_SETTINGS_KEY = 'llm.settings';
const MCP_SETTINGS_KEY = 'mcp.settings';
const MAX_PAGE_STATE_BYTES = 200_000;

const TOOL_SETTING_KEYS = [
  'tools.sandbox',
  'tools.sandboxBackend',
  'tools.workspaceRoot',
  'tools.toolAccessMode',
  'tools.allow',
  'tools.deny',
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

function toolAccessModeValue(value: unknown, fallback: ToolSettings['toolAccessMode']): ToolSettings['toolAccessMode'] {
  return value === 'allow' || value === 'deny' ? value : fallback;
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

function uniqStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
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

function defaultToolSettings(): ToolSettings {
  return {
    sandbox: config.tools.sandbox,
    sandboxBackend: config.tools.sandboxBackend,
    workspaceRoot: config.tools.workspaceRoot,
    toolAccessMode: config.tools.toolAccessMode,
    allow: config.tools.allow,
    deny: config.tools.deny,
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
    models: [defaultModel],
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

function rowsToMap(rows: SettingRow[]): Map<string, unknown> {
  return new Map(rows.map((row) => [row.key, row.value]));
}

function mergeToolSettings(values: Map<string, unknown>): ToolSettings {
  const defaults = defaultToolSettings();
  const allow = stringList(values.get('tools.allow'), defaults.allow);
  const deny = stringList(values.get('tools.deny'), defaults.deny);
  return {
    sandbox: sandboxValue(values.get('tools.sandbox'), defaults.sandbox),
    sandboxBackend: backendValue(values.get('tools.sandboxBackend'), defaults.sandboxBackend),
    workspaceRoot: resolve(stringValue(values.get('tools.workspaceRoot'), defaults.workspaceRoot)),
    toolAccessMode: toolAccessModeValue(values.get('tools.toolAccessMode'), allow.length ? 'allow' : defaults.toolAccessMode),
    allow,
    deny,
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

async function readSettingRows(tenantId: string, keys: readonly string[]): Promise<SettingRow[]> {
  const { rows } = await query<SettingRow>(
    `SELECT key, value FROM app_settings WHERE tenant_id = $1 AND key = ANY($2::text[])`,
    [tenantId, [...keys]],
  );
  return rows;
}

/** 只给 default 租户播种基础层默认值;其它租户没有覆盖就一路 fallback 到
 *  default 租户的值再到 env 默认值(见 getToolSettings),不自动写入具体值。 */
async function insertMissingDefaults(rows: SettingRow[]): Promise<void> {
  const existing = new Set(rows.map((row) => row.key));
  for (const [key, value] of toolSettingsToEntries(defaultToolSettings())) {
    if (existing.has(key)) continue;
    await query(
      `INSERT INTO app_settings (tenant_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [DEFAULT_TENANT_ID, key, JSON.stringify(value)],
    );
  }
}

/** 读取当前租户的工具配置:本租户覆盖 -> default 租户覆盖 -> env 默认值三层回退
 *  (docs/multi-tenancy-design.md §5)。配置表不可用时回退到 env 默认值,避免未迁移
 *  环境直接崩溃。 */
export async function getToolSettings(scope: TenantScope): Promise<ToolSettings> {
  try {
    const ownRows = await readSettingRows(scope.tenantId, TOOL_SETTING_KEYS);
    let mergedMap = rowsToMap(ownRows);
    if (scope.tenantId === DEFAULT_TENANT_ID) {
      if (ownRows.length < TOOL_SETTING_KEYS.length) await insertMissingDefaults(ownRows);
      mergedMap = rowsToMap(await readSettingRows(DEFAULT_TENANT_ID, TOOL_SETTING_KEYS));
    } else {
      const missingKeys = TOOL_SETTING_KEYS.filter((key) => !mergedMap.has(key));
      if (missingKeys.length) {
        const defaultRows = await readSettingRows(DEFAULT_TENANT_ID, missingKeys);
        mergedMap = new Map([...rowsToMap(defaultRows), ...mergedMap]);
      }
    }
    const settings = mergeToolSettings(mergedMap);
    // workspaceRoot 永远是按租户计算出来的值,不信任 app_settings 里存的字符串——
    // 否则租户管理员能把自己的 workspaceRoot 设成指向另一个租户目录,变成一个真实的
    // 越权读写洞(docs/multi-tenancy-design.md §11)。
    settings.workspaceRoot = resolveWorkspaceRoot(scope.tenantId);
    return settings;
  } catch (err) {
    warnOnce('settings-fallback', `Tool settings fallback to env defaults: ${(err as Error).message}`);
    const fallback = defaultToolSettings();
    fallback.workspaceRoot = resolveWorkspaceRoot(scope.tenantId);
    return fallback;
  }
}

function toolSettingsToEntries(settings: ToolSettings): Array<[string, unknown]> {
  return [
    ['tools.sandbox', settings.sandbox],
    ['tools.sandboxBackend', settings.sandboxBackend],
    ['tools.workspaceRoot', settings.workspaceRoot],
    ['tools.toolAccessMode', settings.toolAccessMode],
    ['tools.allow', settings.allow],
    ['tools.deny', settings.deny],
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
  for (const [key, value] of toolSettingsToEntries(settings)) {
    await query(
      `INSERT INTO app_settings (tenant_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [scope.tenantId, key, JSON.stringify(value)],
    );
  }
  // 存进去的值可能被调用方 normalize 出一个不受信任的 workspaceRoot,但返回值必须是
  // 计算出来的那个——同一个理由见 getToolSettings。
  settings.workspaceRoot = resolveWorkspaceRoot(scope.tenantId);
  return settings;
}

function normalizeMcpServer(input: unknown, fallback: McpServerSettings, usedIds: Set<string>): McpServerSettings {
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawId = mcpServerIdValue(body.id, fallback.id);
  let id = rawId;
  for (let i = 2; usedIds.has(id); i += 1) id = `${rawId}-${i}`;
  usedIds.add(id);
  return {
    id,
    label: stringValue(body.label, fallback.label || id),
    enabled: boolValue(body.enabled, fallback.enabled),
    url: stringValue(body.url, fallback.url),
    bearerToken: typeof body.bearerToken === 'string' ? body.bearerToken : fallback.bearerToken,
    headers: keyValueList(body.headers),
    allowedTools: uniqStrings(stringList(body.allowedTools, fallback.allowedTools)),
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
    enabled: false,
    url: '',
    bearerToken: '',
    headers: [],
    allowedTools: [],
    timeoutMs: 60_000,
    maxOutput: 40_000,
  };
  return {
    servers: rawServers.map((server, index) => normalizeMcpServer(server, { ...fallback, id: `mcp-${index + 1}` }, usedIds)),
  };
}

async function readTenantJsonSetting(tenantId: string, key: string): Promise<unknown> {
  const { rows } = await query<SettingRow>(`SELECT value FROM app_settings WHERE tenant_id = $1 AND key = $2`, [tenantId, key]);
  return rows[0]?.value;
}

/** 本租户覆盖 -> default 租户覆盖 两层回退,给 mcp/llm 这类单行 JSON 配置用。 */
async function readJsonSettingWithFallback(tenantId: string, key: string): Promise<unknown> {
  const own = await readTenantJsonSetting(tenantId, key);
  if (own !== undefined) return own;
  if (tenantId === DEFAULT_TENANT_ID) return undefined;
  return readTenantJsonSetting(DEFAULT_TENANT_ID, key);
}

async function upsertTenantJsonSetting(tenantId: string, key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, key, JSON.stringify(value)],
  );
}

export async function getMcpSettings(scope: TenantScope): Promise<McpSettings> {
  try {
    const value = await readJsonSettingWithFallback(scope.tenantId, MCP_SETTINGS_KEY);
    if (value === undefined) {
      const defaults = defaultMcpSettings();
      if (scope.tenantId === DEFAULT_TENANT_ID) {
        await query(
          `INSERT INTO app_settings (tenant_id, key, value, updated_at)
           VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (tenant_id, key) DO NOTHING`,
          [DEFAULT_TENANT_ID, MCP_SETTINGS_KEY, JSON.stringify(defaults)],
        );
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
  const requestedDefaultModel = typeof body.defaultModel === 'string' && body.defaultModel.trim() ? body.defaultModel.trim() : fallback.defaultModel;
  const defaultModel = models.includes(requestedDefaultModel) ? requestedDefaultModel : models[0] ?? '';

  return {
    id,
    label: stringValue(body.label, fallback.label || id),
    provider: llmProviderNameValue(body.provider, fallback.provider),
    baseUrl: stringValue(body.baseUrl, fallback.baseUrl),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : fallback.apiKey,
    discoveredModels: uniqStrings([...discoveredModels, ...models]),
    models,
    defaultModel,
    maxTokens: positiveIntValue(body.maxTokens, fallback.maxTokens, 1, 200_000),
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
    const value = await readJsonSettingWithFallback(scope.tenantId, LLM_SETTINGS_KEY);
    if (value === undefined) {
      const defaults = defaultLlmSettings();
      if (scope.tenantId === DEFAULT_TENANT_ID) {
        await query(
          `INSERT INTO app_settings (tenant_id, key, value, updated_at)
           VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (tenant_id, key) DO NOTHING`,
          [DEFAULT_TENANT_ID, LLM_SETTINGS_KEY, JSON.stringify(defaults)],
        );
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
  const { rows } = await query<SettingRow>(`SELECT value FROM app_settings WHERE tenant_id = $1 AND key = $2`, [scope.tenantId, PAGE_STATE_KEY]);
  return normalizePageState(rows[0]?.value);
}

export async function savePageState(scope: TenantScope, input: unknown): Promise<Record<string, unknown>> {
  const state = normalizePageState(input);
  await upsertTenantJsonSetting(scope.tenantId, PAGE_STATE_KEY, state);
  return state;
}
