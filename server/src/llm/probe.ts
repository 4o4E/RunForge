import type {
  LlmInputModality,
  LlmModelCapabilitySettings,
  LlmProviderChatTestResult,
  LlmProviderPingResult,
  LlmProviderProbeResult,
  LlmProviderSettings,
} from '@runforge/contracts';
import { createProviderFromSettings } from './index.js';
import { mergeModelCapability } from './modelCatalog.js';
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

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number === 'number' && Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function modalitiesFromItem(row: Record<string, unknown>): LlmInputModality[] | undefined {
  const architecture = objectValue(row.architecture);
  const capabilities = objectValue(row.capabilities);
  const raw = row.input_modalities
    ?? row.inputModalities
    ?? row.modalities
    ?? row.supported_input_modalities
    ?? architecture.input_modalities
    ?? architecture.inputModalities;
  const values = Array.isArray(raw) ? raw.map((item) => String(item).toLowerCase()) : [];
  const enabled = new Set<LlmInputModality>(['text']);
  if (values.some((item) => item === 'image' || item === 'images' || item === 'vision')) enabled.add('image');
  if (values.some((item) => item === 'audio' || item === 'audios')) enabled.add('audio');
  if (values.some((item) => item === 'video' || item === 'videos')) enabled.add('video');

  const featureValues = Array.isArray(row.features) ? row.features.map((item) => String(item).toLowerCase()) : [];
  const enabledFlag = (...items: unknown[]) => items.some((item) => item === true);
  if (enabledFlag(row.vision, row.supports_vision, row.supportsVision, capabilities.vision) || featureValues.includes('vision')) enabled.add('image');
  if (enabledFlag(row.audio, row.supports_audio, row.supportsAudio, capabilities.audio) || featureValues.includes('audio')) enabled.add('audio');
  if (enabledFlag(row.video, row.supports_video, row.supportsVideo, capabilities.video) || featureValues.includes('video')) enabled.add('video');

  return raw !== undefined || featureValues.length || enabled.size > 1 ? [...enabled] : undefined;
}

function capabilityFromItem(item: unknown): LlmModelCapabilitySettings | null {
  const model = modelNameFromItem(item);
  if (!model) return null;
  const row = objectValue(item);
  const architecture = objectValue(row.architecture);
  const topProvider = objectValue(row.top_provider);
  return mergeModelCapability(model, {
    contextWindow: positiveNumber(
      row.context_length,
      row.contextLength,
      row.context_window,
      row.contextWindow,
      row.max_model_len,
      row.maxModelLen,
      row.max_context_length,
      row.inputTokenLimit,
      architecture.context_length,
      topProvider.context_length,
    ),
    inputModalities: modalitiesFromItem(row),
  });
}

export function parseLlmModelList(body: unknown): LlmModelCapabilitySettings[] {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const candidates = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(body)
        ? body
        : [];
  const byModel = new Map<string, LlmModelCapabilitySettings>();
  for (const item of candidates) {
    const capability = capabilityFromItem(item);
    if (capability) byModel.set(capability.model, capability);
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/** 探测供应商公开的模型列表和能力；缺失字段由静态目录补齐，但不直接保存配置。 */
export async function probeLlmProviderModels(provider: LlmProviderSettings): Promise<LlmProviderProbeResult> {
  if (provider.provider === 'mock') {
    return { models: ['mock'], modelCapabilities: [mergeModelCapability('mock')], source: 'mock' };
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
    const modelCapabilities = parseLlmModelList(await res.json());
    if (!modelCapabilities.length) throw new Error('模型列表为空或返回格式无法识别');
    return { models: modelCapabilities.map((item) => item.model), modelCapabilities, source: url };
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
