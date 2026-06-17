import { Router } from 'express';
import type { LlmProviderSettings, LlmSettingsOptions, ShellCommandOptionItem, ToolSettingsOptionItem, ToolSettingsOptions } from '@my-agent/contracts';
import { getLlmSettings, getPageState, getToolSettings, llmModelOptions, normalizeLlmSettings, saveLlmSettings, savePageState, saveToolSettings, shellPathForSettings } from '../settings.js';
import { toolSchemas } from '../tools/registry.js';
import { findExecutable, scanExecutableNames } from '../tools/sandbox.js';
import { config } from '../config.js';
import { pingLlmProvider, probeLlmProviderModels, testLlmProviderChat } from '../llm/probe.js';

export const settingsApi = Router();

function uniq(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function toolOptions(): ToolSettingsOptionItem[] {
  return toolSchemas()
    .map((tool) => ({ name: tool.name, description: tool.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function shellCommandOptions(names: string[], envPath = process.env.PATH ?? ''): ShellCommandOptionItem[] {
  return uniq(names)
    .map((name) => {
      const path = findExecutable(name, envPath) ?? null;
      return { name, path, available: Boolean(path) };
    })
    .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}

function llmProviderFromBody(body: unknown): LlmProviderSettings {
  const row = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const nestedProvider = row.provider && typeof row.provider === 'object' ? row.provider : row;
  const settings = normalizeLlmSettings({ providers: [nestedProvider] });
  return settings.providers[0];
}

export async function getToolSettingsOptions(): Promise<ToolSettingsOptions> {
  const settings = await getToolSettings();
  const envPath = shellPathForSettings(settings);
  return {
    tools: toolOptions(),
    shellCommands: shellCommandOptions([...config.tools.shellAllowCommands, ...settings.shellAllowCommands], envPath),
    systemPath: process.env.PATH ?? '',
  };
}

export async function getLlmSettingsOptions(): Promise<LlmSettingsOptions> {
  const settings = await getLlmSettings();
  return { models: llmModelOptions(settings) };
}

settingsApi.get('/tools', async (_req, res) => {
  res.json(await getToolSettings());
});

settingsApi.get('/tools/options', async (_req, res) => {
  res.json(await getToolSettingsOptions());
});

settingsApi.post('/tools/shell-commands/scan', async (req, res) => {
  const settings = await getToolSettings();
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const shellPathMode = body.shellPathMode === 'custom' ? 'custom' : 'system';
  const shellPath = typeof body.shellPath === 'string' ? body.shellPath : settings.shellPath;
  const include = Array.isArray(body.include) ? body.include.map(String) : settings.shellAllowCommands;
  const envPath = shellPathMode === 'custom' ? shellPath : process.env.PATH ?? '';
  res.json({
    path: envPath,
    shellCommands: shellCommandOptions([...include, ...scanExecutableNames(envPath)], envPath),
  });
});

settingsApi.put('/tools', async (req, res) => {
  try {
    res.json(await saveToolSettings(req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

settingsApi.get('/llm', async (_req, res) => {
  res.json(await getLlmSettings());
});

settingsApi.get('/llm/options', async (_req, res) => {
  res.json(await getLlmSettingsOptions());
});

settingsApi.put('/llm', async (req, res) => {
  try {
    res.json(await saveLlmSettings(req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

settingsApi.post('/llm/provider/models', async (req, res) => {
  try {
    res.json(await probeLlmProviderModels(llmProviderFromBody(req.body)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

settingsApi.post('/llm/provider/ping', async (req, res) => {
  res.json(await pingLlmProvider(llmProviderFromBody(req.body)));
});

settingsApi.post('/llm/provider/chat-test', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const provider = llmProviderFromBody(body);
    const model = typeof body.model === 'string' ? body.model : '';
    const input = typeof body.input === 'string' ? body.input : '';
    res.json(await testLlmProviderChat(provider, model, input));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

settingsApi.get('/page-state', async (_req, res) => {
  res.json(await getPageState());
});

settingsApi.put('/page-state', async (req, res) => {
  try {
    res.json(await savePageState(req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
