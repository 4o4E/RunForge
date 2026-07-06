import type {
  LlmProviderChatTestResult,
  LlmProviderPingResult,
  LlmProviderProbeResult,
  LlmProviderSettings,
} from '@runforge/contracts';
import { createProviderFromSettings } from './index.js';
import type { LlmMessage } from './types.js';

function elapsedSince(started: number): number {
  return Math.max(0, Date.now() - started);
}

function modelsUrl(provider: LlmProviderSettings): string {
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  return `${baseUrl}/models`;
}

function modelHeaders(provider: LlmProviderSettings): Record<string, string> {
  if (provider.provider === 'anthropic' || (provider.provider === 'aisdk' && provider.aisdkFlavor === 'anthropic')) {
    return {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
}

function modelNameFromItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const value = row.id ?? row.name ?? row.model;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseModelList(body: unknown): string[] {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const candidates = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(body)
        ? body
        : [];
  return [...new Set(candidates.map(modelNameFromItem).filter((name): name is string => Boolean(name)))].sort();
}

/** 探测供应商公开的模型列表，只返回模型名，不保存配置。 */
export async function probeLlmProviderModels(provider: LlmProviderSettings): Promise<LlmProviderProbeResult> {
  if (provider.provider === 'mock') {
    return { models: ['mock'], source: 'mock' };
  }

  const url = modelsUrl(provider);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(provider.timeoutMs, 30_000));
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: modelHeaders(provider),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const models = parseModelList(await res.json());
    if (!models.length) throw new Error('模型列表为空或返回格式无法识别');
    return { models, source: url };
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? `请求超时：${url}` : (err as Error).message;
    throw new Error(`模型探测失败：${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function pingLlmProvider(provider: LlmProviderSettings): Promise<LlmProviderPingResult> {
  const started = Date.now();
  try {
    const result = await probeLlmProviderModels(provider);
    return {
      ok: true,
      latencyMs: elapsedSince(started),
      message: `模型列表可访问：${result.source}`,
      modelCount: result.models.length,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: elapsedSince(started),
      message: (err as Error).message,
    };
  }
}

export async function testLlmProviderChat(provider: LlmProviderSettings, model: string, input: string): Promise<LlmProviderChatTestResult> {
  const selectedModel = model.trim() || provider.defaultModel || provider.models[0] || provider.discoveredModels[0] || '';
  if (!selectedModel) throw new Error('缺少测试模型');
  const prompt = input.trim() || '请只回复“可用”。';
  const started = Date.now();
  const llm = createProviderFromSettings(provider, selectedModel);
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: '你是模型可用性检查。请用最短中文回复。',
    },
    {
      role: 'user',
      content: prompt,
    },
  ];
  const result = await llm.complete(messages, []);
  return {
    ok: true,
    latencyMs: elapsedSince(started),
    model: selectedModel,
    input: prompt,
    output: result.content?.trim() || '模型未返回文本',
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  };
}
