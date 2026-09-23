import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ModelCatalogDocument } from '@runforge/contracts';
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
