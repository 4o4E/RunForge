import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuntimeCapabilitiesSettings } from './settings.js';
import { renderRuntimeCapabilitiesContext } from './agent/context.js';

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
