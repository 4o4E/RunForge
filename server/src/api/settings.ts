import { Router } from 'express';
import type { LlmSettingsOptions, McpSettingsOptions, ToolSettingsOptions } from '@runforge/contracts';
import { getLlmSettings, getPageState, getSystemMcpSettings, llmModelOptions, savePageState } from '../settings.js';
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

export async function getToolSettingsOptions(): Promise<ToolSettingsOptions> {
  return {
    systemPath: process.env.PATH ?? '',
  };
}

export async function getLlmSettingsOptions(scope: TenantScope): Promise<LlmSettingsOptions> {
  const settings = await getLlmSettings(scope);
  return {
    defaultModelRef: settings.defaultModelRef,
    titleModelRef: settings.titleModelRef,
    models: llmModelOptions(settings),
  };
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
