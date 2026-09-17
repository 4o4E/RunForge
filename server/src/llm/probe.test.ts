import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogCapability, normalizeModelName } from './modelCatalog.js';
import { parseLlmModelList } from './probe.js';

test('model probe: 只提取和去重模型名称', () => {
  assert.deepEqual(parseLlmModelList({
    data: [
      { id: 'model-b', context_window: 32_000, modalities: ['text', 'image'] },
      { id: 'model-a' },
      { id: 'model-b' },
      { name: 'model-c' },
    ],
  }), ['model-a', 'model-b', 'model-c']);
});

test('model catalog: 完整名称和明确别名自动填写能力与资料来源', () => {
  assert.equal(normalizeModelName(' GLM 5.2 '), 'glm-5-2');
  assert.deepEqual(catalogCapability('deepseek-ai/deepseek-v4-flash-260425'), {
    model: 'deepseek-ai/deepseek-v4-flash-260425',
    contextWindow: 1_048_576,
    contextWindowSource: 'catalog',
    inputModalities: ['text'],
    inputModalitiesSource: 'catalog',
    references: [{
      title: 'DeepSeek V4 Flash model card',
      url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash',
      checkedAt: '2026-09-18',
      fields: ['contextWindow', 'inputModalities'],
    }],
  });
  assert.equal(catalogCapability('glm-5-2-260617').contextWindow, 1_048_576);
  assert.equal(catalogCapability('deepseek-v4-pro-ga-260813').contextWindow, 1_048_576);
  assert.equal(catalogCapability('kimi-k2-6').contextWindow, 262_144);
  assert.deepEqual(catalogCapability('kimi-k2-6').inputModalities, ['text', 'image', 'video']);
  assert.equal(catalogCapability('claude-opus-4-6').contextWindow, 1_000_000);
  assert.deepEqual(catalogCapability('claude-sonnet-4-6').inputModalities, ['text', 'image']);
  assert.equal(catalogCapability('claude-haiku-4-5').contextWindow, 200_000);
  assert.deepEqual(catalogCapability('gemini-2.5-pro').inputModalities, ['text', 'image', 'audio', 'video', 'document']);
});

test('model catalog: 未声明版本保持待人工填写，不能继承名称前缀', () => {
  for (const model of ['gpt-5', 'gpt-5.5-preview', 'deepseek-v4-pro-preview', 'unrelated-owner/gpt-4o-mini', 'custom-model']) {
    assert.deepEqual(catalogCapability(model), {
      model,
      contextWindow: null,
      contextWindowSource: 'manual',
      inputModalities: [],
      inputModalitiesSource: 'manual',
      references: [],
    });
  }
});
