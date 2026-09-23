import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLlmSettings,
  normalizeRuntimeCapabilitiesSettings,
  normalizeTenantResourceAuthorization,
} from './settings.js';
import { renderPromptTemplate, runtimeCapabilityPromptValues } from './spaces/prompt.js';
import { agentContextSettings } from './config.js';
import { createProviderFromSettings } from './llm/index.js';

test('agent context settings: 使用模型压缩阈值，环境变量只能进一步收紧', () => {
  const original = process.env.LLM_CONTEXT_BUDGET;
  try {
    delete process.env.LLM_CONTEXT_BUDGET;
    assert.deepEqual(agentContextSettings(1_048_576, 200_000), {
      modelContextWindow: 1_048_576,
      contextBudget: 200_000,
      contextBudgetSource: 'model-compaction-threshold',
    });

    process.env.LLM_CONTEXT_BUDGET = 'not-a-number';
    assert.equal(agentContextSettings(200_000, 150_000).contextBudget, 150_000);
    assert.throws(() => agentContextSettings(100_000, 120_000), /压缩阈值/);

    process.env.LLM_CONTEXT_BUDGET = '90000';
    assert.deepEqual(agentContextSettings(200_000, 150_000), {
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
    titleModelRef: 'openai:custom-model',
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
        compactionThreshold: 24_000,
        compactionThresholdSource: 'manual',
        inputModalities: ['text', 'audio'],
        inputModalitiesSource: 'manual',
      }],
      defaultModel: 'gpt-4.1-mini',
      timeoutMs: 120_000,
      retries: 2,
    }],
  });

  const provider = settings.providers[0];
  assert.equal(settings.titleModelRef, 'openai:custom-model');
  assert.equal(provider.modelCapabilities.find((item) => item.model === 'gpt-4.1-mini')?.contextWindow, 1_047_576);
  assert.equal(provider.modelCapabilities.find((item) => item.model === 'gpt-4.1-mini')?.references.length, 1);
  assert.deepEqual(provider.modelCapabilities.find((item) => item.model === 'custom-model'), {
    model: 'custom-model',
    contextWindow: 32_000,
    contextWindowSource: 'manual',
    compactionThreshold: 24_000,
    compactionThresholdSource: 'manual',
    maxOutputTokens: null,
    inputModalities: ['text', 'audio'],
    inputModalitiesSource: 'manual',
    references: [],
  });
});

test('llm settings: 已保存的模型能力不会被打包目录覆盖', () => {
  const settings = normalizeLlmSettings({
    providers: [{
      id: 'deepseek',
      models: ['deepseek-v4-flash-260425'],
      discoveredModels: ['deepseek-v4-flash-260425'],
      modelCapabilities: [{
        model: 'deepseek-v4-flash-260425',
        contextWindow: 128_000,
        contextWindowSource: 'catalog',
        compactionThreshold: 96_000,
        compactionThresholdSource: 'catalog',
        maxOutputTokens: 16_000,
        inputModalities: ['text'],
        inputModalitiesSource: 'catalog',
      }],
    }],
  });

  const capability = settings.providers[0].modelCapabilities[0];
  assert.equal(capability.contextWindow, 128_000);
  assert.equal(capability.contextWindowSource, 'catalog');
  assert.equal(capability.compactionThreshold, 96_000);
  assert.equal(capability.compactionThresholdSource, 'catalog');
  assert.equal(capability.maxOutputTokens, 16_000);
});

test('llm settings: 旧 Anthropic 配置补齐输出长度，新配置使用已保存数值', () => {
  const legacy = normalizeLlmSettings({ providers: [{
    id: 'anthropic',
    protocol: 'anthropic-messages',
    models: ['claude-sonnet-4-6'],
  }] }).providers[0];
  assert.equal(legacy.modelCapabilities[0]?.maxOutputTokens, 64_000);

  const saved = normalizeLlmSettings({ providers: [{
    id: 'anthropic',
    protocol: 'anthropic-messages',
    models: ['custom-claude'],
    modelCapabilities: [{
      model: 'custom-claude',
      contextWindow: 200_000,
      contextWindowSource: 'catalog',
      compactionThreshold: 150_000,
      compactionThresholdSource: 'catalog',
      maxOutputTokens: 32_000,
      inputModalities: ['text', 'image'],
      inputModalitiesSource: 'catalog',
      references: [],
    }],
  }] }).providers[0];
  assert.equal(saved.modelCapabilities[0]?.maxOutputTokens, 32_000);
  assert.doesNotThrow(() => createProviderFromSettings(saved, 'custom-claude'));
});

test('llm settings: 新候选集合移除旧条目并保留已启用模型', () => {
  const previous = normalizeLlmSettings({
    providers: [{
      id: 'provider',
      discoveredModels: ['old-unselected-model', 'selected-legacy-model'],
      models: ['selected-legacy-model'],
    }],
  });
  const settings = normalizeLlmSettings({
    ...previous,
    providers: [{ ...previous.providers[0], discoveredModels: ['new-model'] }],
  });

  assert.deepEqual(settings.providers[0].discoveredModels, ['new-model', 'selected-legacy-model']);
  assert.deepEqual(settings.providers[0].models, ['selected-legacy-model']);
});

test('llm settings: 管理员可以覆盖目录生成的压缩阈值', () => {
  const settings = normalizeLlmSettings({
    providers: [{
      id: 'openai',
      models: ['gpt-5.5'],
      modelCapabilities: [{
        model: 'gpt-5.5',
        contextWindowSource: 'catalog',
        compactionThreshold: 200_000,
        compactionThresholdSource: 'manual',
        inputModalitiesSource: 'catalog',
      }],
    }],
  });
  const capability = settings.providers[0].modelCapabilities[0];
  assert.equal(capability.contextWindow, 1_050_000);
  assert.equal(capability.compactionThreshold, 200_000);
  assert.equal(capability.compactionThresholdSource, 'manual');
});

test('llm settings: 人工字段缺失时不会从打包目录静默补值', () => {
  const capability = normalizeLlmSettings({ providers: [{
    id: 'openai',
    models: ['gpt-4.1-mini'],
    modelCapabilities: [{
      model: 'gpt-4.1-mini',
      contextWindowSource: 'manual',
      compactionThresholdSource: 'manual',
      inputModalitiesSource: 'manual',
    }],
  }] }).providers[0].modelCapabilities[0];
  assert.equal(capability.contextWindow, null);
  assert.equal(capability.compactionThreshold, null);
  assert.deepEqual(capability.inputModalities, []);
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

test('llm settings: 忽略旧输出上限和流式开关', () => {
  const settings = normalizeLlmSettings({
    providers: [{ id: 'legacy-transport-options', maxTokens: 4096, stream: false }],
  });

  assert.equal('maxTokens' in settings.providers[0], false);
  assert.equal('stream' in settings.providers[0], false);
});

test('llm settings: 未登记模型不会生成默认能力', () => {
  const settings = normalizeLlmSettings({ providers: [{ id: 'custom', models: ['private-model'] }] });
  assert.deepEqual(settings.providers[0].modelCapabilities[0], {
    model: 'private-model',
    contextWindow: null,
    contextWindowSource: 'manual',
    compactionThreshold: null,
    compactionThresholdSource: 'manual',
    maxOutputTokens: null,
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

  const values = runtimeCapabilityPromptValues(settings);
  const text = renderPromptTemplate(
    `运行时内部能力:
- 已启用运行资源: {{runtime.enabledCapabilities}}
{{runtime.capabilityDetails}}
- 调用能力时使用 modelId。`,
    {
      'runtime.enabledCapabilities': values.enabledCapabilities,
      'runtime.capabilityDetails': values.capabilityDetails,
    },
  );

  assert.match(text, /可选模型 id: fast/);
  assert.match(text, /可选模型 id: poster/);
  assert.match(text, /modelId/);
  assert.doesNotMatch(text, /secret-image-key/);
  assert.doesNotMatch(text, /https:\/\/img\.example\.test/);
  assert.doesNotMatch(text, /openai:gpt-4\.1-mini/);
});

test('tenant resource authorization: 规范化并去重系统资源 ID', () => {
  assert.deepEqual(normalizeTenantResourceAuthorization({
    llmProviderIds: [' openai ', 'openai', 'anthropic'],
    datasourceIds: ['ds_one', '', 'ds_one', 'ds_two'],
  }), {
    llmProviderIds: ['openai', 'anthropic'],
    datasourceIds: ['ds_one', 'ds_two'],
  });
  assert.deepEqual(normalizeTenantResourceAuthorization(null), {
    llmProviderIds: [],
    datasourceIds: [],
  });
});
