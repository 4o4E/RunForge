import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLlmSettings, normalizeRuntimeCapabilitiesSettings } from './settings.js';
import { renderRuntimeCapabilitiesContext } from './agent/context.js';
import { agentContextSettings } from './config.js';

test('agent context settings: 按模型窗口计算预算，并忽略非法环境变量', () => {
  const original = process.env.LLM_CONTEXT_BUDGET;
  try {
    delete process.env.LLM_CONTEXT_BUDGET;
    assert.deepEqual(agentContextSettings(1_048_576), {
      modelContextWindow: 1_048_576,
      contextBudget: 524_288,
      contextBudgetSource: 'model-settings',
    });

    process.env.LLM_CONTEXT_BUDGET = 'not-a-number';
    assert.equal(agentContextSettings(200_000).contextBudget, 100_000);

    process.env.LLM_CONTEXT_BUDGET = '90000';
    assert.deepEqual(agentContextSettings(200_000), {
      modelContextWindow: 200_000,
      contextBudget: 90_000,
      contextBudgetSource: 'env',
    });
  } finally {
    if (original === undefined) delete process.env.LLM_CONTEXT_BUDGET;
    else process.env.LLM_CONTEXT_BUDGET = original;
  }
});

test('llm settings: 目录模型自动补齐能力，人工配置保持原值', () => {
  const settings = normalizeLlmSettings({
    defaultModelRef: 'openai:gpt-4.1-mini',
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      discoveredModels: ['gpt-4.1-mini', 'custom-model'],
      models: ['gpt-4.1-mini', 'custom-model'],
      modelCapabilities: [{
        model: 'custom-model',
        contextWindow: 32_000,
        contextWindowSource: 'manual',
        inputModalities: ['text', 'audio'],
        inputModalitiesSource: 'manual',
      }],
      defaultModel: 'gpt-4.1-mini',
      maxTokens: 4096,
      timeoutMs: 120_000,
      retries: 2,
      stream: true,
    }],
  });

  const provider = settings.providers[0];
  assert.equal(provider.modelCapabilities.find((item) => item.model === 'gpt-4.1-mini')?.contextWindow, 1_047_576);
  assert.equal(provider.modelCapabilities.find((item) => item.model === 'gpt-4.1-mini')?.references.length, 1);
  assert.deepEqual(provider.modelCapabilities.find((item) => item.model === 'custom-model'), {
    model: 'custom-model',
    contextWindow: 32_000,
    contextWindowSource: 'manual',
    inputModalities: ['text', 'audio'],
    inputModalitiesSource: 'manual',
    references: [],
  });
});

test('llm settings: 已保存的目录值按完整别名刷新', () => {
  const settings = normalizeLlmSettings({
    providers: [{
      id: 'deepseek',
      models: ['deepseek-v4-flash-260425'],
      discoveredModels: ['deepseek-v4-flash-260425'],
      modelCapabilities: [{
        model: 'deepseek-v4-flash-260425',
        contextWindow: 128_000,
        contextWindowSource: 'catalog',
        inputModalities: ['text'],
        inputModalitiesSource: 'catalog',
      }],
    }],
  });

  const capability = settings.providers[0].modelCapabilities[0];
  assert.equal(capability.contextWindow, 1_048_576);
  assert.equal(capability.contextWindowSource, 'catalog');
});

test('llm settings: 旧 AI SDK 配置转换为明确协议并删除旧字段', () => {
  const settings = normalizeLlmSettings({
    providers: [{
      id: 'legacy',
      provider: 'aisdk',
      aisdkFlavor: 'anthropic',
      reasoningTag: 'think',
      models: ['claude-sonnet-4-6'],
    }],
  });

  assert.equal(settings.providers[0].protocol, 'anthropic-messages');
  assert.equal('provider' in settings.providers[0], false);
  assert.equal('aisdkFlavor' in settings.providers[0], false);
  assert.equal('reasoningTag' in settings.providers[0], false);
});

test('llm settings: 输出 token 上限允许显式设为空', () => {
  const settings = normalizeLlmSettings({
    providers: [{ id: 'no-local-output-limit', maxTokens: null }],
  });

  assert.equal(settings.providers[0].maxTokens, null);
});

test('llm settings: 未登记模型不会生成默认能力', () => {
  const settings = normalizeLlmSettings({ providers: [{ id: 'custom', models: ['private-model'] }] });
  assert.deepEqual(settings.providers[0].modelCapabilities[0], {
    model: 'private-model',
    contextWindow: null,
    contextWindowSource: 'manual',
    inputModalities: [],
    inputModalitiesSource: 'manual',
    references: [],
  });
});

test('runtime capability settings: 支持每个能力配置多个可选模型', () => {
  const settings = normalizeRuntimeCapabilitiesSettings({
    llm: {
      enabled: true,
      defaultModelId: 'fast',
      models: [
        { id: 'fast', label: '快速模型', modelRef: 'openai:gpt-4.1-mini' },
        { id: 'deep', label: '深度模型', modelRef: 'anthropic:claude-sonnet-4' },
      ],
    },
    image: {
      enabled: true,
      defaultModelId: 'poster',
      models: [
        { id: 'poster', label: '海报图', provider: 'packy-gpt-image-2', baseUrl: 'https://img.example.test', apiKey: 'secret-image-key', model: 'gpt-image-2', timeoutMs: 90_000 },
        { id: 'draft', label: '草图', provider: 'packy-gpt-image-2', baseUrl: 'https://img2.example.test', apiKey: 'secret-image-key-2', model: 'gpt-image-2-low', timeoutMs: 60_000 },
      ],
    },
    video: {
      enabled: true,
      defaultModelId: 'clip',
      models: [{ id: 'clip', label: '短视频', provider: 'future-video', model: 'v1' }],
    },
  });

  assert.equal(settings.llm.defaultModelId, 'fast');
  assert.deepEqual(settings.llm.models.map((model) => model.id), ['fast', 'deep']);
  assert.equal(settings.image.defaultModelId, 'poster');
  assert.deepEqual(settings.image.models.map((model) => model.id), ['poster', 'draft']);
  assert.equal(settings.video.defaultModelId, 'clip');
});

test('runtime capability settings: 旧图片单模型配置会迁移成模型列表', () => {
  const settings = normalizeRuntimeCapabilitiesSettings({
    image: {
      enabled: true,
      baseUrl: 'https://legacy-img.example.test',
      apiKey: 'legacy-secret',
      model: 'gpt-image-2',
      timeoutMs: 120_000,
    },
  });

  assert.equal(settings.image.enabled, true);
  assert.equal(settings.image.defaultModelId, 'image-1');
  assert.equal(settings.image.models.length, 1);
  assert.equal(settings.image.models[0].baseUrl, 'https://legacy-img.example.test');
  assert.equal(settings.image.models[0].apiKey, 'legacy-secret');
});

test('runtime capability prompt: 只注入运行时模型 id，不注入上游密钥', () => {
  const settings = normalizeRuntimeCapabilitiesSettings({
    llm: { enabled: true, models: [{ id: 'fast', label: '快速模型', modelRef: 'openai:gpt-4.1-mini' }] },
    image: {
      enabled: true,
      models: [{ id: 'poster', label: '海报图', provider: 'packy-gpt-image-2', baseUrl: 'https://img.example.test', apiKey: 'secret-image-key', model: 'gpt-image-2', timeoutMs: 90_000 }],
    },
  });

  const text = renderRuntimeCapabilitiesContext(settings);

  assert.match(text, /可选模型 id: fast/);
  assert.match(text, /可选模型 id: poster/);
  assert.match(text, /modelId/);
  assert.doesNotMatch(text, /secret-image-key/);
  assert.doesNotMatch(text, /https:\/\/img\.example\.test/);
  assert.doesNotMatch(text, /openai:gpt-4\.1-mini/);
});
