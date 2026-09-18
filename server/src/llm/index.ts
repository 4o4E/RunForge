import type { LlmConfig, Provider } from './types.js';
import { createAiSdkProvider } from './providers/aiSdk.js';
import { getLlmSettings, type LlmProviderSettings } from '../settings.js';
import type { TenantScope } from '../store/types.js';
import type { ProviderDescriptor } from './providerRunner.js';
import { catalogMaxOutputTokens } from './modelCatalog.js';

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
    maxOutputTokens: catalogMaxOutputTokens(model),
    timeoutMs: provider.timeoutMs,
    retries: provider.retries,
  };
}

export function createProviderFromSettings(provider: LlmProviderSettings, model: string): Provider {
  return createAiSdkProvider(configFromProvider(provider, model), { protocol: provider.protocol });
}

export async function getConfiguredProvider(scope: TenantScope, modelRef?: string): Promise<{
  provider: Provider;
  descriptor: ProviderDescriptor;
  modelRef: string;
  contextWindow: number;
  compactionThreshold: number;
}> {
  const settings = await getLlmSettings(scope);
  const ref = modelRef?.trim() || settings.defaultModelRef;
  const parsed = parseModelRef(ref);
  if (!parsed) throw new Error(`模型引用格式无效：${ref}。请使用 provider:model，例如 default:gpt-4o-mini`);
  const providerSettings = settings.providers.find((item) => item.id === parsed.providerId);
  if (!providerSettings) throw new Error(`没有找到 LLM 供应商：${parsed.providerId}`);
  if (!providerSettings.models.includes(parsed.model)) {
    throw new Error(`供应商 ${providerSettings.id} 未配置模型：${parsed.model}`);
  }
  const capability = providerSettings.modelCapabilities.find((item) => item.model === parsed.model);
  if (!capability?.contextWindow || !capability.compactionThreshold || !capability.inputModalities.length) {
    throw new Error(`模型 ${ref} 的上下文长度、压缩阈值或输入类型尚未配置`);
  }
  const provider = createProviderFromSettings(providerSettings, parsed.model);
  return {
    provider,
    descriptor: {
      provider: provider.name,
      model: parsed.model,
      retries: Math.max(0, providerSettings.retries),
    },
    modelRef: ref,
    contextWindow: capability.contextWindow,
    compactionThreshold: capability.compactionThreshold,
  };
}

export type { Provider } from './types.js';
