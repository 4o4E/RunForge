import { resolve } from 'node:path';
import { config } from './config.js';
import { query } from './db/pool.js';
import type { SandboxBackendName } from './tools/sandbox.js';
import type { ToolPolicyConfig } from './tools/policy.js';

export interface ToolSettings extends ToolPolicyConfig {
  sandboxBackend: SandboxBackendName;
  shellAllowCommands: string[];
  shellUseHostPath: boolean;
}

type SettingRow = { key: string; value: unknown };

const TOOL_SETTING_KEYS = [
  'tools.sandbox',
  'tools.sandboxBackend',
  'tools.workspaceRoot',
  'tools.allow',
  'tools.deny',
  'tools.shellEnabled',
  'tools.shellUseHostPath',
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

function defaultToolSettings(): ToolSettings {
  return {
    sandbox: config.tools.sandbox,
    sandboxBackend: config.tools.sandboxBackend,
    workspaceRoot: config.tools.workspaceRoot,
    allow: config.tools.allow,
    deny: config.tools.deny,
    shellEnabled: config.tools.shellEnabled,
    shellUseHostPath: config.tools.shellUseHostPath,
    shellAllowCommands: config.tools.shellAllowCommands,
    network: config.tools.network,
    shellDeny: config.tools.shellDeny,
    maxOutput: config.tools.maxOutput,
  };
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
    allow: stringList(values.get('tools.allow'), defaults.allow),
    deny: stringList(values.get('tools.deny'), defaults.deny),
    shellEnabled: boolValue(values.get('tools.shellEnabled'), defaults.shellEnabled),
    shellUseHostPath: boolValue(values.get('tools.shellUseHostPath'), defaults.shellUseHostPath),
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
    ['tools.allow', settings.allow],
    ['tools.deny', settings.deny],
    ['tools.shellEnabled', settings.shellEnabled],
    ['tools.shellUseHostPath', settings.shellUseHostPath],
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
