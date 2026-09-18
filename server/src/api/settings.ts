import { Router } from 'express';
import type { LlmSettingsOptions, McpSettingsOptions, ShellCommandOptionItem, ToolSettingsOptions } from '@runforge/contracts';
import { getLlmSettings, getPageState, getSystemMcpSettings, getSystemToolSettings, llmModelOptions, savePageState, shellPathForSettings } from '../settings.js';
import { findExecutable } from '../tools/sandbox.js';
import { config } from '../config.js';
import { listMcpTools } from '../mcp/client.js';
import { requireScope } from '../auth/context.js';
import type { TenantScope } from '../store/types.js';
import type { Response } from 'express';
import { rejectSystemManagedAccess } from '../auth/guards.js';

export const settingsApi = Router();

function scopeOrReject(res: Response): TenantScope | null {
  const scope = requireScope();
  if (!scope) {
    res.status(403).json({ error: '需要租户身份' });
    return null;
  }
  return scope;
}

function uniq(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function shellCommandOptions(names: string[], envPath = process.env.PATH ?? ''): ShellCommandOptionItem[] {
  return uniq(names)
    .map((name) => {
      const path = findExecutable(name, envPath) ?? null;
      return { name, path, available: Boolean(path) };
    })
    .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}

export async function getToolSettingsOptions(): Promise<ToolSettingsOptions> {
  const settings = await getSystemToolSettings();
  const envPath = shellPathForSettings(settings);
  return {
    shellCommands: shellCommandOptions([...config.tools.shellAllowCommands, ...settings.shellAllowCommands], envPath),
    systemPath: process.env.PATH ?? '',
  };
}

export async function getLlmSettingsOptions(scope: TenantScope): Promise<LlmSettingsOptions> {
  const settings = await getLlmSettings(scope);
  return { defaultModelRef: settings.defaultModelRef, models: llmModelOptions(settings) };
}

export async function getMcpSettingsOptions(): Promise<McpSettingsOptions> {
  const settings = await getSystemMcpSettings();
  const tools = await listMcpTools(settings);
  return {
    tools: tools.map((tool) => ({
      serverId: tool.serverId,
      serverLabel: tool.serverLabel,
      name: tool.originalName,
      mappedName: tool.mappedName,
      description: tool.description,
    })),
  };
}

settingsApi.get([
  '/tools',
  '/tools/options',
  '/mcp',
  '/mcp/options',
  '/llm',
  '/runtime-capabilities',
], rejectSystemManagedAccess);

settingsApi.post([
  '/tools/shell-commands/scan',
  '/mcp/server/probe',
  '/llm/provider/models',
  '/llm/model-capability',
  '/llm/provider/ping',
  '/llm/provider/chat-test',
], rejectSystemManagedAccess);

settingsApi.put([
  '/tools',
  '/mcp',
  '/llm',
  '/runtime-capabilities',
], rejectSystemManagedAccess);

settingsApi.get('/llm/options', async (_req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  res.json(await getLlmSettingsOptions(scope));
});

settingsApi.get('/page-state', async (_req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  res.json(await getPageState(scope));
});

settingsApi.put('/page-state', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    res.json(await savePageState(scope, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
