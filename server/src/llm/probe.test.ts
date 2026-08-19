import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogCapability, mergeModelCapability, normalizeModelName } from './modelCatalog.js';
import { parseLlmModelList } from './probe.js';

test('model catalog: 厂商版本和别名归一化后没有冲突', () => {
  const catalog = JSON.parse(readFileSync(new URL('./model-catalog.json', import.meta.url), 'utf8')) as Array<{
    vendor: string;
    version: string;
    aliases?: string[];
  }>;
  const owners = new Map<string, string>();
  for (const entry of catalog) {
    const owner = `${entry.vendor} ${entry.version}`;
    for (const identity of [entry.version, ...(entry.aliases ?? []), owner]) {
      const normalized = normalizeModelName(identity);
      const existing = owners.get(normalized);
      assert.ok(!existing || existing === owner, `模型目录标识 ${normalized} 同时属于 ${existing} 和 ${owner}`);
      owners.set(normalized, owner);
    }
  }
});

test('model catalog: 按模型系列补齐上下文和多模态能力', () => {
  assert.deepEqual(catalogCapability('gpt-4.1-mini'), {
    model: 'gpt-4.1-mini',
    contextWindow: 1_048_576,
    contextWindowSource: 'catalog',
    inputModalities: ['text', 'image'],
    inputModalitiesSource: 'catalog',
  });
  assert.deepEqual(catalogCapability('deepseek-v3'), {
    model: 'deepseek-v3',
    contextWindow: 128_000,
    contextWindowSource: 'catalog',
    inputModalities: ['text'],
    inputModalitiesSource: 'catalog',
  });
  assert.deepEqual(catalogCapability('deepseek-v4-flash-260425'), {
    model: 'deepseek-v4-flash-260425',
    contextWindow: 1_048_576,
    contextWindowSource: 'catalog',
    inputModalities: ['text'],
    inputModalitiesSource: 'catalog',
  });
  assert.equal(catalogCapability('deepseek-ai/deepseek-v4-flash-260425').contextWindow, 1_048_576);
  assert.equal(catalogCapability('glm-5-2-260810').contextWindow, 1_048_576);
  assert.deepEqual(catalogCapability('kimi-k2-6-260701'), {
    model: 'kimi-k2-6-260701',
    contextWindow: 262_144,
    contextWindowSource: 'catalog',
    inputModalities: ['text', 'image', 'video'],
    inputModalitiesSource: 'catalog',
  });
  assert.deepEqual(catalogCapability('qwen3-vl-plus').inputModalities, ['text', 'image', 'video']);
});

test('model catalog: 厂商版本可匹配点号、空格、横线和下划线差异', () => {
  assert.equal(normalizeModelName(' GLM 5.2 '), 'glm-5-2');
  for (const model of ['glm-5-2-flash', 'glm 5.2 flash', 'glm_5_2_flash', 'zhipu-ai/glm-5-2-flash']) {
    assert.equal(catalogCapability(model).contextWindow, 1_048_576, model);
  }
  for (const model of ['kimi-k2-6', 'kimi k2.6', 'moonshot-ai/kimi_k2_6-latest']) {
    assert.equal(catalogCapability(model).contextWindow, 262_144, model);
  }
});

test('model probe: 上游能力优先，缺失字段由静态目录补齐', () => {
  const capabilities = parseLlmModelList({
    data: [
      { id: 'gpt-4.1-mini', context_length: 222_000 },
      { id: 'custom-vision', max_model_len: '65536', capabilities: { vision: true } },
      { id: 'gemini-2.5-pro', architecture: { input_modalities: ['text', 'image', 'audio', 'video'] } },
    ],
  });

  assert.deepEqual(capabilities[0], {
    model: 'custom-vision',
    contextWindow: 65_536,
    contextWindowSource: 'provider',
    inputModalities: ['text', 'image'],
    inputModalitiesSource: 'provider',
  });
  assert.equal(capabilities.find((item) => item.model === 'gpt-4.1-mini')?.contextWindow, 222_000);
  assert.deepEqual(capabilities.find((item) => item.model === 'gpt-4.1-mini')?.inputModalities, ['text', 'image']);
  assert.deepEqual(capabilities.find((item) => item.model === 'gemini-2.5-pro')?.inputModalities, ['text', 'image', 'audio', 'video']);
});

test('model capability merge: 上游只覆盖实际提供的字段', () => {
  assert.deepEqual(mergeModelCapability('claude-sonnet-4', { contextWindow: 180_000 }), {
    model: 'claude-sonnet-4',
    contextWindow: 180_000,
    contextWindowSource: 'provider',
    inputModalities: ['text', 'image'],
    inputModalitiesSource: 'catalog',
  });
});
