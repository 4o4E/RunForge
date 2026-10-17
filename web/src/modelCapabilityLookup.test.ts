import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateModelCatalogEntries, type ModelCatalogDocument } from '@runforge/contracts';
import { capabilityFromCatalogEntries } from './sysAdmin/settings/modelCapabilityLookup';

const catalog = JSON.parse(readFileSync(new URL('../../server/src/llm/model-catalog.json', import.meta.url), 'utf8')) as ModelCatalogDocument;

test('浏览器能力匹配使用真实目录的模型别名和完整参数', () => {
  const capability = capabilityFromCatalogEntries(catalog.models, 'claude-sonnet-4-6');
  assert.equal(capability.contextWindow, 1_000_000);
  assert.equal(capability.compactionThreshold, 750_000);
  assert.equal(capability.maxOutputTokens, 64_000);
  assert.deepEqual(capability.inputModalities, ['text', 'image', 'document']);
  assert.equal(capability.references[0]?.url, 'https://models.dev/models/anthropic/claude-sonnet-4-6');
});

test('没有匹配资料时保留人工填写状态', () => {
  const capability = capabilityFromCatalogEntries(catalog.models, 'private-model');
  assert.equal(capability.contextWindow, null);
  assert.equal(capability.maxOutputTokens, null);
  assert.deepEqual(capability.inputModalities, []);
});

test('重复规范身份保留独立参数且不影响其他模型的供应商别名', () => {
  const nova = {
    name: 'Nova 2 Lite',
    family: 'nova',
    release_date: '2025-12-02',
    modalities: { input: ['text', 'image', 'video', 'pdf'] },
  };
  const unique = {
    id: 'example/unique',
    name: 'Unique',
    family: 'unique',
    release_date: '2026-01-01',
    limit: { context: 200_000, output: 8_000 },
    modalities: { input: ['text'] },
  };
  const result = generateModelCatalogEntries({
    'amazon/nova-2-lite': { ...nova, id: 'amazon/nova-2-lite', limit: { context: 1_000_000, output: 65_536 } },
    'amazon/nova-2-lite-v1': { ...nova, id: 'amazon/nova-2-lite-v1', limit: { context: 1_000_000, output: 65_535 } },
    'amazon/nova-2-lite-variant': { ...nova, id: 'amazon/nova-2-lite-variant', limit: { context: 500_000, output: 32_768 } },
    'example/unique': unique,
  }, {
    provider: { models: {
      'provider.nova-lite': nova,
      'provider.unique': unique,
    } },
  }, '2026-10-17');

  assert.equal(capabilityFromCatalogEntries(result.models, 'amazon/nova-2-lite').maxOutputTokens, 65_536);
  assert.equal(capabilityFromCatalogEntries(result.models, 'amazon/nova-2-lite-v1').maxOutputTokens, 65_535);
  assert.equal(capabilityFromCatalogEntries(result.models, 'amazon/nova-2-lite-variant').contextWindow, 500_000);
  assert.equal(capabilityFromCatalogEntries(result.models, 'provider.nova-lite').contextWindow, null);
  assert.equal(capabilityFromCatalogEntries(result.models, 'provider.unique').contextWindow, 200_000);
});
