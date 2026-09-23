import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogCapability, catalogMaxOutputTokens, normalizeModelName } from './modelCatalog.js';
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
  const deepseek = catalogCapability('deepseek-ai/deepseek-v4-flash-260425');
  assert.equal(deepseek.contextWindow, 1_000_000);
  assert.equal(deepseek.compactionThreshold, 750_000);
  assert.deepEqual(deepseek.inputModalities, ['text']);
  assert.equal(deepseek.references[0]?.url, 'https://models.dev/models/deepseek/deepseek-v4-flash');
  assert.equal(catalogCapability('glm-5-2-260617').contextWindow, 1_000_000);
  assert.equal(catalogCapability('deepseek-v4-pro-ga-260813').contextWindow, 1_000_000);
  assert.equal(catalogCapability('gpt-5.5-preview').compactionThreshold, 787_500);
  assert.equal(catalogCapability('gpt-5.2-2025-12-11').contextWindow, 400_000);
  assert.equal(catalogCapability('deepseek-v4-pro-preview').contextWindow, 1_000_000);
  assert.equal(catalogCapability('glm5.3').contextWindow, 1_000_000);
  assert.equal(catalogCapability('zai-org/GLM-5.3').contextWindow, 1_000_000);
  assert.equal(catalogCapability('glm5.3-260901').contextWindow, 1_000_000);
  assert.deepEqual(catalogCapability('zai-org/glm-5.3-flash-fp8').inputModalities, ['text', 'image', 'video', 'document']);
  assert.deepEqual(catalogCapability('zai-org/glm-5.3-260901').inputModalities, ['text']);
  assert.equal(catalogCapability('kimi-k2-6').contextWindow, 262_144);
  assert.deepEqual(catalogCapability('kimi-k2-6').inputModalities, ['text', 'image', 'video']);
  assert.equal(catalogCapability('kimi-k2.7-code-260915').contextWindow, 262_144);
  assert.deepEqual(catalogCapability('minimax-m3-highspeed').inputModalities, ['text', 'image', 'video']);
  assert.equal(catalogCapability('claude-opus-4-6').contextWindow, 1_000_000);
  assert.deepEqual(catalogCapability('claude-sonnet-4-6').inputModalities, ['text', 'image', 'document']);
  assert.equal(catalogMaxOutputTokens('claude-sonnet-4-6'), 64_000);
  assert.equal(catalogCapability('claude-haiku-4-5').contextWindow, 200_000);
  assert.deepEqual(catalogCapability('gemini-2.5-pro').inputModalities, ['text', 'image', 'audio', 'video', 'document']);
});

test('model catalog: 只继承已登记名称的后缀，未知名称保持待人工填写', () => {
  for (const model of ['unrelated-owner/gpt-4o-mini', 'custom-model']) {
    assert.deepEqual(catalogCapability(model), {
      model,
      contextWindow: null,
      contextWindowSource: 'manual',
      compactionThreshold: null,
      compactionThresholdSource: 'manual',
      maxOutputTokens: null,
      inputModalities: [],
      inputModalitiesSource: 'manual',
      references: [],
    });
  }
});
