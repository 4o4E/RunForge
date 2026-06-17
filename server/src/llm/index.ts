import { config } from '../config.js';
import type { LlmConfig, Provider } from './types.js';
import { createAiSdkProvider, type AiSdkFlavor } from './providers/aiSdk.js';
import { createOpenAIResponsesProvider } from './providers/openaiResponses.js';
import { createOpenAIChatProvider } from './providers/openaiChat.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createMockProvider } from './providers/mock.js';
import { getLlmSettings, type LlmProviderSettings } from '../settings.js';

// `aisdk` is the default (Phase 2). The legacy hand-written providers are kept
// selectable as a rollback path until the AI SDK path is validated in real use.
export type ProviderName = 'aisdk' | 'openai-responses' | 'openai-chat' | 'anthropic' | 'mock';

interface ProviderCreateOptions {
  aisdkFlavor?: AiSdkFlavor;
  reasoningTag?: string;
}

export function createProvider(name: ProviderName, cfg: LlmConfig, opts: ProviderCreateOptions = {}): Provider {
  switch (name) {
    case 'aisdk':
      return createAiSdkProvider(cfg, {
        flavor: opts.aisdkFlavor ?? (config.llm.aisdkFlavor as AiSdkFlavor),
        reasoningTag: opts.reasoningTag ?? config.llm.reasoningTag,
      });
    case 'openai-responses':
      return createOpenAIResponsesProvider(cfg);
    case 'openai-chat':
      return createOpenAIChatProvider(cfg);
    case 'anthropic':
      return createAnthropicProvider(cfg);
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}

function parseModelRef(ref: string): { providerId: string; model: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx >= ref.length - 1) return null;
  return { providerId: ref.slice(0, idx).trim(), model: ref.slice(idx + 1).trim() };
}

function configFromProvider(provider: LlmProviderSettings, model: string): LlmConfig {
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    maxTokens: provider.maxTokens,
    timeoutMs: provider.timeoutMs,
    retries: provider.retries,
  };
}

export function createProviderFromSettings(provider: LlmProviderSettings, model: string): Provider {
  return createProvider(provider.provider, configFromProvider(provider, model), {
    aisdkFlavor: provider.aisdkFlavor,
    reasoningTag: provider.reasoningTag,
  });
}

export async function getConfiguredProvider(modelRef?: string): Promise<{ provider: Provider; modelRef: string; stream: boolean }> {
  const settings = await getLlmSettings();
  const ref = modelRef?.trim() || settings.defaultModelRef;
  const parsed = parseModelRef(ref);
  if (!parsed) throw new Error(`模型引用格式无效：${ref}。请使用 provider:model，例如 default:${config.llm.model}`);
  const providerSettings = settings.providers.find((item) => item.id === parsed.providerId);
  if (!providerSettings) throw new Error(`没有找到 LLM 供应商：${parsed.providerId}`);
  if (!providerSettings.models.includes(parsed.model)) {
    throw new Error(`供应商 ${providerSettings.id} 未配置模型：${parsed.model}`);
  }
  return {
    provider: createProviderFromSettings(providerSettings, parsed.model),
    modelRef: ref,
    stream: providerSettings.stream,
  };
}

let cached: Provider | null = null;

/** The process-wide provider selected by config (LLM_PROVIDER). */
export function getProvider(): Provider {
  if (!cached) {
    cached = createProvider(config.llm.provider as ProviderName, {
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      timeoutMs: config.llm.timeoutMs,
      retries: config.llm.retries,
    });
  }
  return cached;
}

export type { Provider } from './types.js';
