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

async function readSettingRows(keys: readonly string[]): Promise<SettingRow[]> {
  const { rows } = await query<SettingRow>(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [[...keys]]);
  return rows;
}

async function insertMissingDefaults(rows: SettingRow[]): Promise<void> {
  const existing = new Set(rows.map((row) => row.key));
  for (const [key, value] of toolSettingsToEntries(defaultToolSettings())) {
    if (existing.has(key)) continue;
    await query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)],
    );
  }
}

/** 读取当前工具配置。配置表不可用时回退到 env 默认值,避免未迁移环境直接崩溃。 */
export async function getToolSettings(): Promise<ToolSettings> {
  try {
    const rows = await readSettingRows(TOOL_SETTING_KEYS);
    if (rows.length < TOOL_SETTING_KEYS.length) await insertMissingDefaults(rows);
    return mergeToolSettings(rowsToMap(rows));
  } catch (err) {
    warnOnce('settings-fallback', `Tool settings fallback to env defaults: ${(err as Error).message}`);
    return defaultToolSettings();
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

export async function saveToolSettings(input: unknown): Promise<ToolSettings> {
  const settings = normalizeToolSettings(input);
  for (const [key, value] of toolSettingsToEntries(settings)) {
    await query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
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

export async function getMcpSettings(): Promise<McpSettings> {
  try {
    const { rows } = await query<SettingRow>(`SELECT value FROM app_settings WHERE key = $1`, [MCP_SETTINGS_KEY]);
    if (!rows.length) {
      const defaults = defaultMcpSettings();
      await query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO NOTHING`,
        [MCP_SETTINGS_KEY, JSON.stringify(defaults)],
      );
      return defaults;
    }
    return normalizeMcpSettings(rows[0].value);
  } catch (err) {
    warnOnce('mcp-settings-fallback', `MCP settings fallback to empty defaults: ${(err as Error).message}`);
    return defaultMcpSettings();
  }
}

export async function saveMcpSettings(input: unknown): Promise<McpSettings> {
  const settings = normalizeMcpSettings(input);
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [MCP_SETTINGS_KEY, JSON.stringify(settings)],
  );
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

export async function getLlmSettings(): Promise<LlmSettings> {
  try {
    const { rows } = await query<SettingRow>(`SELECT value FROM app_settings WHERE key = $1`, [LLM_SETTINGS_KEY]);
    if (!rows[0]) {
      const defaults = defaultLlmSettings();
      await query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO NOTHING`,
        [LLM_SETTINGS_KEY, JSON.stringify(defaults)],
      );
      return defaults;
    }
    return normalizeLlmSettings(rows[0].value);
  } catch (err) {
    warnOnce('llm-settings-fallback', `LLM settings fallback to env defaults: ${(err as Error).message}`);
    return defaultLlmSettings();
  }
}

export async function saveLlmSettings(input: unknown): Promise<LlmSettings> {
  const settings = normalizeLlmSettings(input);
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [LLM_SETTINGS_KEY, JSON.stringify(settings)],
  );
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

export async function getPageState(): Promise<Record<string, unknown>> {
  const { rows } = await query<SettingRow>(`SELECT value FROM app_settings WHERE key = $1`, [PAGE_STATE_KEY]);
  return normalizePageState(rows[0]?.value);
}

export async function savePageState(input: unknown): Promise<Record<string, unknown>> {
  const state = normalizePageState(input);
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PAGE_STATE_KEY, JSON.stringify(state)],
  );
  return state;
}
