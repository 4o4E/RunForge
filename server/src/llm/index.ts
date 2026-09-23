import type { LlmConfig, Provider } from './types.js';
import { createAiSdkProvider } from './providers/aiSdk.js';
import { getLlmSettings, getSystemLlmSettings, type LlmProviderSettings, type LlmSettings } from '../settings.js';
import type { TenantScope } from '../store/types.js';
import type { ProviderDescriptor } from './providerRunner.js';

function parseModelRef(ref: string): { providerId: string; model: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx >= ref.length - 1) return null;
  return { providerId: ref.slice(0, idx).trim(), model: ref.slice(idx + 1).trim() };
}

function configFromProvider(provider: LlmProviderSettings, model: string): LlmConfig {
  const capability = provider.modelCapabilities.find((item) => item.model === model);
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    maxOutputTokens: capability?.maxOutputTokens ?? null,
    timeoutMs: provider.timeoutMs,
    retries: provider.retries,
  };
}

export function createProviderFromSettings(provider: LlmProviderSettings, model: string): Provider {
  return createAiSdkProvider(configFromProvider(provider, model), { protocol: provider.protocol });
}

type ConfiguredProvider = {
  provider: Provider;
  descriptor: ProviderDescriptor;
  modelRef: string;
  contextWindow: number;
  compactionThreshold: number;
};

function configuredProvider(settings: LlmSettings, modelRef: string | undefined, fallbackRef: string): ConfiguredProvider {
  const ref = modelRef?.trim() || fallbackRef;
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

export async function getConfiguredProvider(scope: TenantScope, modelRef?: string): Promise<ConfiguredProvider> {
  const settings = await getLlmSettings(scope);
  return configuredProvider(settings, modelRef, settings.defaultModelRef);
}

/** 标题生成是系统内部任务，直接使用系统供应商目录，不读取租户授权子集。 */
export async function getConfiguredSystemTitleProvider(): Promise<ConfiguredProvider> {
  const settings = await getSystemLlmSettings();
  return configuredProvider(settings, settings.titleModelRef, settings.defaultModelRef);
}

export type { Provider } from './types.js';
