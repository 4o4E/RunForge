import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memoryStore.js';
import {
  normalizeSpaceConfig,
  SpaceConfigError,
  SpaceConfigService,
  type TenantSpaceCapabilityCatalog,
} from './config.js';
import { RunAdmissionService } from './runAdmission.js';
import type { BusinessPluginDefinition } from '../businessPlugins/types.js';

const businessPlugin: BusinessPluginDefinition = {
  root: '/plugins/tn_config/crm',
  manifestPath: '/plugins/tn_config/crm/runforge.plugin.yaml',
  contentHash: 'a'.repeat(64),
  manifest: {
    schemaVersion: 1,
    id: 'crm',
    version: '1.0.0',
    displayName: 'CRM',
    description: 'CRM business capability',
    skills: [],
    mcpServers: [],
    secrets: [],
    resources: [],
    configSchema: {},
  },
};

const catalog: TenantSpaceCapabilityCatalog = {
  defaultModelRef: 'main:model-a',
  modelContextWindows: {
    'main:model-a': 100_000,
    'main:model-b': 20_000,
  },
  modelRefs: ['main:model-a', 'main:model-b'],
  modelOptions: [
    { ref: 'main:model-a', providerId: 'main', providerLabel: 'Main', provider: 'mock', model: 'model-a', label: 'Model A' },
    { ref: 'main:model-b', providerId: 'main', providerLabel: 'Main', provider: 'mock', model: 'model-b', label: 'Model B' },
  ],
  toolNames: ['file_read', 'file_write', 'ask_user'],
  mcpServerIds: ['browser', 'docs'],
  mcpServers: [{ id: 'browser', label: 'Browser' }, { id: 'docs', label: 'Docs' }],
  businessPluginIds: ['crm'],
  businessPlugins: [{ id: 'crm', label: 'CRM', description: 'CRM business capability', contentHash: businessPlugin.contentHash }],
  businessPluginDefinitions: [businessPlugin],
  businessPluginConfigs: { crm: { region: 'cn' } },
  runtimeCapabilities: ['datasource.credentials', 'image'],
  runtimeSettings: {
    llm: { enabled: false, defaultModelId: '', models: [] },
    image: {
      enabled: true,
      defaultModelId: 'image-main',
      models: [{
        id: 'image-main',
        label: 'Image Main',
        provider: 'packy-gpt-image-2',
        baseUrl: 'https://secret-upstream.test',
        apiKey: 'must-not-enter-run-snapshot',
        model: 'image-model',
        timeoutMs: 30_000,
      }],
    },
    video: { enabled: false, defaultModelId: '', models: [] },
  },
};

function configService() {
  return new SpaceConfigService(async () => structuredClone(catalog));
}

test('space config: 空配置保持兼容，未知字段和越权能力被拒绝', async () => {
  const service = configService();
  assert.deepEqual(normalizeSpaceConfig({}), {
    schemaVersion: 1,
    systemPrompt: '',
    model: { defaultModelRef: null, allowedModelRefs: null, contextBudget: null },
    capabilities: { tools: null, mcpServers: null, businessPlugins: [], runtime: null },
    external: { allowTrustedPrompt: false, allowNextStep: false },
  });
  assert.throws(() => normalizeSpaceConfig({ unknown: true }), SpaceConfigError);
  await assert.rejects(
    service.normalizeForSave('tn_config', 'web', { capabilities: { tools: ['shell'] } }),
    (error: unknown) => error instanceof SpaceConfigError && /shell/.test(error.message),
  );
  await assert.rejects(
    service.normalizeForSave('tn_config', 'web', { model: { allowedModelRefs: [] } }),
    (error: unknown) => error instanceof SpaceConfigError && /至少需要允许一个/.test(error.message),
  );
});

test('space config: run 接纳解析显式能力并从 external 空间双重移除 ask_user', async () => {
  const service = configService();
  const normalized = await service.normalizeForSave('tn_config', 'external', {
    systemPrompt: '  只输出审计结果  ',
    model: {
      defaultModelRef: 'main:model-b',
      allowedModelRefs: ['main:model-b', 'main:model-b'],
      contextBudget: 30_000,
    },
    capabilities: {
      tools: ['file_read', 'ask_user'],
      mcpServers: ['docs'],
      businessPlugins: ['crm'],
      runtime: ['image'],
    },
    external: { allowTrustedPrompt: true, allowNextStep: true },
  });
  const resolved = await service.resolveForRun('tn_config', {
    id: 'sp_config',
    tenant_id: 'tn_config',
    mode: 'external',
    name: 'External',
    execution_user_id: 'us_exec',
    config: normalized,
    config_version: 3,
    created_by_user_id: null,
    visible_user_ids: [],
    deleted_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });

  assert.equal(resolved.modelRef, 'main:model-b');
  assert.equal(resolved.snapshot.model.contextBudget, 10_000);
  assert.equal(resolved.snapshot.model.contextBudgetSource, 'space-config');
  assert.deepEqual(resolved.snapshot.capabilities.tools, ['file_read']);
  assert.deepEqual(resolved.snapshot.capabilities.mcpServers, ['docs']);
  assert.deepEqual(resolved.snapshot.capabilities.businessPlugins, ['crm']);
  assert.deepEqual(resolved.snapshot.capabilities.runtime, ['image']);
  assert.equal(resolved.pluginLock.plugins[0]?.id, 'business.crm');
  assert.deepEqual(resolved.pluginLock.plugins[0]?.config, { region: 'cn' });
  assert.equal(resolved.snapshot.systemPrompt, '只输出审计结果');
  assert.equal(JSON.stringify(resolved.runtimeCapabilitiesSnapshot).includes('must-not-enter-run-snapshot'), false);
  assert.deepEqual(resolved.runtimeCapabilitiesSnapshot.image.models, [{ id: 'image-main', label: 'Image Main' }]);
});

test('space config: 业务插件声明的系统资源必须由空间统一 WORKLOAD_TOKEN 授权', async () => {
  const resourcePlugin = structuredClone(businessPlugin);
  resourcePlugin.manifest.resources = [{ type: 'llm.proxy' }];
  const service = new SpaceConfigService(async () => ({
    ...structuredClone(catalog),
    businessPluginDefinitions: [resourcePlugin],
    runtimeCapabilities: ['datasource.credentials', 'llm', 'image'],
    runtimeSettings: {
      ...structuredClone(catalog.runtimeSettings),
      llm: {
        enabled: true,
        defaultModelId: 'runtime-main',
        models: [{ id: 'runtime-main', label: 'Runtime Main', modelRef: 'main:model-a' }],
      },
    },
  }));

  await assert.rejects(
    service.normalizeForSave('tn_config', 'web', {
      capabilities: { businessPlugins: ['crm'], runtime: ['image'] },
    }),
    /业务插件所需运行资源未被空间授权：llm/,
  );
  const accepted = await service.normalizeForSave('tn_config', 'web', {
    capabilities: { businessPlugins: ['crm'], runtime: ['llm'] },
  });
  assert.deepEqual(accepted.capabilities.runtime, ['llm']);
});

test('space config: 继承的 instance 预算也不能超过模型窗口', async () => {
  const service = new SpaceConfigService(async () => ({
    ...structuredClone(catalog),
    defaultModelRef: 'main:model-small',
    modelRefs: ['main:model-small'],
    modelContextWindows: { 'main:model-small': 8_000 },
  }));
  const previous = process.env.LLM_CONTEXT_BUDGET;
  process.env.LLM_CONTEXT_BUDGET = '100000';
  try {
    const resolved = await service.resolveForRun('tn_config', {
      id: 'sp_budget',
      tenant_id: 'tn_config',
      mode: 'web',
      name: 'Budget',
      execution_user_id: null,
      config: normalizeSpaceConfig({}),
      config_version: 1,
      created_by_user_id: null,
      visible_user_ids: [],
      deleted_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    assert.equal(resolved.snapshot.model.contextBudget, 8_000);
  } finally {
    if (previous === undefined) delete process.env.LLM_CONTEXT_BUDGET;
    else process.env.LLM_CONTEXT_BUDGET = previous;
  }
});

test('run admission: 固化配置副本，后续空间更新只影响新 run', async () => {
  const store = new MemoryStore();
  const provisioned = await store.createTenantWithOwner({
    id: 'tn_admission',
    name: 'Admission',
    ownerEmail: 'owner@admission.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
  });
  const scope = { tenantId: provisioned.tenant.id, userId: provisioned.owner.id };
  const config = await configService().normalizeForSave(scope.tenantId, 'web', {
    systemPrompt: 'version one',
    model: { allowedModelRefs: ['main:model-a'] },
  });
  const space = await store.createSpace({
    tenantId: scope.tenantId,
    mode: 'web',
    name: 'Admission Space',
    executionUserId: null,
    config,
    createdByUserId: provisioned.owner.id,
    visibleUserIds: [],
  });
  const thread = await store.createThread(scope, 'Admission Thread', { spaceId: space.id });
  const admission = new RunAdmissionService(store, configService());
  const first = await admission.createWebRun(scope, thread, { input: 'first' });
  assert.equal(first.model_ref, 'main:model-a');
  assert.equal(first.space_config_version, 1);
  assert.equal(typeof first.plugin_lock?.hash, 'string');
  assert.equal((first.space_config_snapshot as unknown as { systemPrompt: string }).systemPrompt, 'version one');
  await store.setRunStatus(scope, first.id, 'done');

  const updatedConfig = await configService().normalizeForSave(scope.tenantId, 'web', {
    systemPrompt: 'version two',
    model: { allowedModelRefs: ['main:model-b'] },
  });
  await store.updateSpace(scope.tenantId, space.id, { config: updatedConfig });
  await assert.rejects(
    store.createRun(scope, thread.id, 'stale config', { expectedSpaceConfigVersion: 1 }),
    /空间配置已更新/,
  );
  const second = await admission.createWebRun(scope, thread, { input: 'second' });
  assert.equal(second.model_ref, 'main:model-b');
  assert.equal(second.space_config_version, 2);
  assert.equal((second.space_config_snapshot as unknown as { systemPrompt: string }).systemPrompt, 'version two');
  assert.equal((first.space_config_snapshot as unknown as { systemPrompt: string }).systemPrompt, 'version one');
});
