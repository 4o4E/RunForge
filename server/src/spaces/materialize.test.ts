import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memoryStore.js';
import { SpaceConfigService, type TenantSpaceCapabilityCatalog } from './config.js';
import { materializeLegacySpaceConfigs } from './materialize.js';

function capabilityCatalog(): TenantSpaceCapabilityCatalog {
  return {
    defaultModelRef: 'main:model-a',
    modelContexts: {
      'main:model-a': { contextWindow: 100_000, compactionThreshold: 75_000 },
    },
    modelRefs: ['main:model-a'],
    modelOptions: [{
      ref: 'main:model-a',
      providerId: 'main',
      providerLabel: 'Main',
      protocol: 'openai-chat',
      model: 'model-a',
      label: 'Model A',
    }],
    toolNames: ['file_read'],
    mcpServerIds: ['docs'],
    mcpServers: [{ id: 'docs', label: 'Docs' }],
    businessPluginIds: [],
    businessPlugins: [],
    businessPluginDefinitions: [],
    businessPluginConfigs: {},
    runtimeCapabilities: ['image'],
    runtimeSettings: {
      llm: { enabled: false, defaultModelId: '', models: [] },
      image: { enabled: true, defaultModelId: 'image-main', models: [] },
      video: { enabled: false, defaultModelId: '', models: [] },
    },
  };
}

test('旧空间配置只转换一次，转换后的能力副本不跟随目录变化', async () => {
  const store = new MemoryStore();
  const provisioned = await store.createTenantWithOwner({
    id: 'tn_materialize',
    name: 'Materialize',
    ownerEmail: 'owner@materialize.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
    defaultSpaceConfig: {
      schemaVersion: 1,
      systemPrompt: '',
      model: { defaultModelRef: null, allowedModelRefs: null, contextBudget: null },
      capabilities: { tools: null, mcpServers: null, businessPlugins: null, runtime: null },
      external: { allowTrustedPrompt: false, allowNextStep: false },
    },
  });
  const catalog = capabilityCatalog();
  const service = new SpaceConfigService(async () => structuredClone(catalog));

  assert.equal(await materializeLegacySpaceConfigs(store, service), 1);
  const first = await store.findSpace(provisioned.tenant.id, provisioned.defaultSpace.id);
  assert.ok(first);
  assert.equal((first.config as { schemaVersion?: number }).schemaVersion, 3);
  assert.equal(typeof (first.config as { promptTemplate?: unknown }).promptTemplate, 'string');
  assert.deepEqual((first.config as { model: unknown }).model, {
    defaultModelRef: 'main:model-a',
    allowedModelRefs: ['main:model-a'],
    contextBudget: null,
  });
  assert.deepEqual((first.config as { capabilities: unknown }).capabilities, {
    tools: ['file_read'],
    mcpServers: ['docs'],
    businessPlugins: [],
    runtime: ['image'],
  });
  assert.equal(first.config_version, 2);

  catalog.modelRefs.push('main:model-b');
  catalog.toolNames.push('file_write');
  catalog.mcpServerIds.push('browser');
  catalog.runtimeCapabilities.push('video');

  assert.equal(await materializeLegacySpaceConfigs(store, service), 0);
  const second = await store.findSpace(provisioned.tenant.id, provisioned.defaultSpace.id);
  assert.deepEqual(second?.config, first.config);
  assert.equal(second?.config_version, 2);
});

test('没有模型授权的租户也会转换为明确的空列表', async () => {
  const store = new MemoryStore();
  const provisioned = await store.createTenantWithOwner({
    id: 'tn_materialize_empty',
    name: 'Materialize Empty',
    ownerEmail: 'owner@materialize-empty.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
    defaultSpaceConfig: {},
  });
  const catalog = capabilityCatalog();
  catalog.defaultModelRef = '';
  catalog.modelContexts = {};
  catalog.modelRefs = [];
  catalog.modelOptions = [];
  const service = new SpaceConfigService(async () => structuredClone(catalog));

  assert.equal(await materializeLegacySpaceConfigs(store, service), 1);
  const space = await store.findSpace(provisioned.tenant.id, provisioned.defaultSpace.id);
  assert.deepEqual(space?.config && (space.config as { model: unknown }).model, {
    defaultModelRef: null,
    allowedModelRefs: [],
    contextBudget: null,
  });
});

test('能力列表完整的 schemaVersion=1 空间也会保存单一提示词模板', async () => {
  const store = new MemoryStore();
  const provisioned = await store.createTenantWithOwner({
    id: 'tn_materialize_prompt_blocks',
    name: 'Materialize Prompt Blocks',
    ownerEmail: 'owner@materialize-prompt-blocks.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
    defaultSpaceConfig: {
      schemaVersion: 1,
      systemPrompt: '旧空间提示词',
      model: { defaultModelRef: 'main:model-a', allowedModelRefs: ['main:model-a'], contextBudget: null },
      capabilities: { tools: ['file_read'], mcpServers: ['docs'], businessPlugins: [], runtime: ['image'] },
      external: { allowTrustedPrompt: false, allowNextStep: false },
    },
  });
  const service = new SpaceConfigService(async () => capabilityCatalog());

  assert.equal(await materializeLegacySpaceConfigs(store, service), 1);
  const space = await store.findSpace(provisioned.tenant.id, provisioned.defaultSpace.id);
  assert.equal((space?.config as { schemaVersion?: number }).schemaVersion, 3);
  assert.match((space?.config as { promptTemplate: string }).promptTemplate, /旧空间提示词/);
  assert.equal(await materializeLegacySpaceConfigs(store, service), 0);
});

test('格式损坏的旧空间配置会阻止转换', async () => {
  const store = new MemoryStore();
  await store.createTenantWithOwner({
    id: 'tn_materialize_invalid',
    name: 'Materialize Invalid',
    ownerEmail: 'owner@materialize-invalid.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
    defaultSpaceConfig: 'invalid' as unknown as Record<string, unknown>,
  });
  const service = new SpaceConfigService(async () => capabilityCatalog());

  await assert.rejects(
    materializeLegacySpaceConfigs(store, service),
    /旧配置转换失败：空间配置必须是对象/,
  );
});
