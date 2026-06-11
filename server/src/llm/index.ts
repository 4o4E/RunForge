import { config } from '../config.js';
import type { LlmConfig, Provider } from './types.js';
import { createAiSdkProvider, type AiSdkFlavor } from './providers/aiSdk.js';
import { createOpenAIResponsesProvider } from './providers/openaiResponses.js';
import { createOpenAIChatProvider } from './providers/openaiChat.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createMockProvider } from './providers/mock.js';

// `aisdk` is the default (Phase 2). The legacy hand-written providers are kept
// selectable as a rollback path until the AI SDK path is validated in real use.
export type ProviderName = 'aisdk' | 'openai-responses' | 'openai-chat' | 'anthropic' | 'mock';

export function createProvider(name: ProviderName, cfg: LlmConfig): Provider {
  switch (name) {
    case 'aisdk':
      return createAiSdkProvider(cfg, {
        flavor: config.llm.aisdkFlavor as AiSdkFlavor,
        reasoningTag: config.llm.reasoningTag,
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
