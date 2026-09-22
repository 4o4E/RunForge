import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../store/memoryStore.js';
import {
  normalizeSpaceConfig,
  SpaceConfigError,
  SpaceConfigService,
  type TenantSpaceCapabilityCatalog,
} from './config.js';
import { RunAdmissionService } from './runAdmission.js';
import type { BusinessPluginDefinition } from '../businessPlugins/types.js';
import { defaultPromptTemplate, renderPromptTemplate } from './prompt.js';

const businessPlugin: BusinessPluginDefinition = {
  root: '/plugins/tn_config/crm',
  manifestPath: '/plugins/tn_config/crm/runforge.plugin.yaml',
  contentHash: 'a'.repeat(64),
  skillEntries: [],
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
  modelContexts: {
    'main:model-a': { contextWindow: 100_000, compactionThreshold: 50_000 },
    'main:model-b': { contextWindow: 20_000, compactionThreshold: 10_000 },
  },
  modelRefs: ['main:model-a', 'main:model-b'],
  modelOptions: [
    { ref: 'main:model-a', providerId: 'main', providerLabel: 'Main', protocol: 'openai-chat', model: 'model-a', label: 'Model A' },
    { ref: 'main:model-b', providerId: 'main', providerLabel: 'Main', protocol: 'openai-chat', model: 'model-b', label: 'Model B' },
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

test('prompt template: 默认配置是单一模板，运行时替换占位符', () => {
  const defaults = defaultPromptTemplate('web');
  assert.match(defaults, /你是 RunForge/);
  assert.doesNotMatch(defaults, /agent_loop|tool_behavior|standard_process/);
  const rendered = renderPromptTemplate('B {{workspace.root}}\n\nA', { 'workspace.root': '/workspace' });
  assert.equal(rendered, 'B /workspace\n\nA');
});

test('prompt template: 已发布旧配置转换为单一模板，无效占位符在保存时被拒绝', () => {
  const migrated = normalizeSpaceConfig({ schemaVersion: 1, systemPrompt: '旧空间指令' }, 'external');
  assert.match(migrated.promptTemplate, /旧空间指令/);
  assert.doesNotMatch(migrated.promptTemplate, /你是 RunForge/);
  assert.throws(() => normalizeSpaceConfig({
    schemaVersion: 3,
    promptTemplate: '{{unknown.value}}',
  }), /未知占位符/);
  assert.throws(() => normalizeSpaceConfig({
    schemaVersion: 3,
    promptTemplate: '{{workspace.root',
  }), /格式错误的占位符/);
  assert.throws(() => normalizeSpaceConfig({ schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => normalizeSpaceConfig({ schemaVersion: 4 }), /schemaVersion/);
});

test('prompt placeholders: 服务端返回完整目录并按空间能力生成预览内容', async () => {
  const service = configService();
  const config = await service.snapshotForCreate('tn_config', 'web');
  config.model = { ...config.model, defaultModelRef: 'removed:model', allowedModelRefs: ['removed:model'] };
  const view = await service.promptPlaceholders('tn_config', 'web', config);
  const placeholders = new Map(view.placeholders.map((item) => [item.key, item]));

  assert.equal(view.placeholders.length, 12);
  assert.equal(placeholders.get('workspace.root')?.token, '{{workspace.root}}');
  assert.equal(placeholders.get('workspace.root')?.runtime, true);
  assert.match(placeholders.get('workflow.catalog')?.content ?? '', /Available workflows/);
  assert.match(placeholders.get('skills.catalog')?.content ?? '', /Available skills/);
  assert.doesNotMatch(placeholders.get('workflow.catalog')?.content ?? '', /当前工作区/);
  assert.doesNotMatch(placeholders.get('skills.catalog')?.content ?? '', /当前工作区/);
  assert.match(placeholders.get('mcp.catalog')?.content ?? '', /browser/);
  assert.equal(placeholders.get('runtime.enabledCapabilities')?.content, 'datasource.credentials, image');
  assert.match(placeholders.get('runtime.capabilityDetails')?.content ?? '', /Image/);
  assert.equal(placeholders.get('external.trustedPrompt')?.runtime, true);
});

test('space config: 调试视图按当前配置列出工具 Schema、业务 Skill 和 MCP', async () => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'runforge-space-debug-'));
  try {
    const skillRoot = join(pluginRoot, 'skills', 'customer-query');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: customer-query',
      'description: 查询客户资料。',
      '---',
      '',
      '# Customer Query',
    ].join('\n'));
    const definition: BusinessPluginDefinition = {
      ...businessPlugin,
      root: pluginRoot,
      manifestPath: join(pluginRoot, 'runforge.plugin.yaml'),
      manifest: {
        ...businessPlugin.manifest,
        skills: [{ id: 'customer-query', path: 'skills/customer-query' }],
        mcpServers: [{
          id: 'crm-records',
          label: 'CRM Records',
          description: '查询 CRM 记录。',
          transport: 'streamable-http',
          url: 'https://crm.example.test/mcp',
          headers: [],
          timeoutMs: 60_000,
          maxOutput: 40_000,
        }],
      },
    };
    const service = new SpaceConfigService(async () => ({
      ...structuredClone(catalog),
      mcpServers: [{ id: 'docs', label: 'Docs', description: '文档服务。' }],
      businessPluginDefinitions: [definition],
    }));
    const view = await service.debugView('tn_config', 7, 'web', {
      systemPrompt: '只输出审查结论。',
      capabilities: {
        tools: ['file_read'],
        mcpServers: ['docs'],
        businessPlugins: ['crm'],
        runtime: [],
      },
    });

    assert.match(view.promptTemplate, /只输出审查结论。/);
    assert.equal(view.tools[0]?.name, 'file_read');
    assert.equal((view.tools[0]?.parameters.properties as Record<string, unknown>).path !== undefined, true);
    assert.deepEqual(view.skills.find((skill) => skill.id === 'business:crm/customer-query'), {
      id: 'business:crm/customer-query',
      name: 'customer-query',
      description: '查询客户资料。',
      content: '# Customer Query',
    });
    assert.ok(view.skills.some((skill) => skill.id.startsWith('builtin:')));
    assert.deepEqual(view.mcpServers.map((server) => server.id), ['docs', 'business-crm-crm-records']);

    const promptConfig = await service.snapshotForCreate('tn_config', 'web', {
      capabilities: {
        tools: ['file_read'],
        mcpServers: ['docs'],
        businessPlugins: ['crm'],
        runtime: [],
      },
    });
    const promptView = await service.promptPlaceholders('tn_config', 'web', promptConfig);
    const promptValues = new Map(promptView.placeholders.map((item) => [item.key, item.content]));
    assert.match(promptValues.get('skills.catalog') ?? '', /business:crm\/customer-query/);
    assert.match(promptValues.get('mcp.catalog') ?? '', /business-crm-crm-records/);
  } finally {
    await rm(pluginRoot, { recursive: true, force: true });
  }
});

test('space config: 创建时复制能力目录，未知字段和越权能力被拒绝', async () => {
  const service = configService();
  const normalizedDefault = normalizeSpaceConfig({});
  assert.equal(normalizedDefault.schemaVersion, 3);
  assert.deepEqual(normalizedDefault.model, { defaultModelRef: null, allowedModelRefs: [], contextBudget: null });
  assert.ok(normalizedDefault.promptTemplate.length > 0);
  const created = await service.snapshotForCreate('tn_config', 'web');
  assert.equal(created.schemaVersion, 3);
  assert.deepEqual(created.model, {
    defaultModelRef: 'main:model-a',
    allowedModelRefs: ['main:model-a', 'main:model-b'],
    contextBudget: null,
  });
  assert.deepEqual(created.capabilities, {
    tools: ['file_read', 'file_write', 'ask_user'],
    mcpServers: ['browser', 'docs'],
    businessPlugins: [],
    runtime: ['datasource.credentials', 'image'],
  });
  assert.deepEqual(
    (await service.snapshotForCreate('tn_config', 'external')).capabilities.tools,
    ['file_read', 'file_write'],
  );
  assert.throws(() => normalizeSpaceConfig({ unknown: true }), SpaceConfigError);
  await assert.rejects(
    service.snapshotForCreate('tn_config', 'web', { capabilities: { tools: ['shell'] } }),
    (error: unknown) => error instanceof SpaceConfigError && /shell/.test(error.message),
  );
  await assert.rejects(
    service.snapshotForCreate('tn_config', 'web', { model: { allowedModelRefs: [] } }),
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
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });

  assert.equal(resolved.modelRef, 'main:model-b');
  assert.equal(resolved.snapshot.model.contextBudget, 10_000);
  assert.equal(resolved.snapshot.model.contextBudgetSource, 'model-compaction-threshold');
  assert.deepEqual(resolved.snapshot.capabilities.tools, ['file_read']);
  assert.deepEqual(resolved.snapshot.capabilities.mcpServers, ['docs']);
  assert.deepEqual(resolved.snapshot.capabilities.businessPlugins, ['crm']);
  assert.deepEqual(resolved.snapshot.capabilities.runtime, ['image']);
  assert.equal(resolved.pluginLock.plugins[0]?.id, 'business.crm');
  assert.deepEqual(resolved.pluginLock.plugins[0]?.config, { region: 'cn' });
  assert.match(resolved.snapshot.promptTemplate, /只输出审计结果/);
  assert.equal(JSON.stringify(resolved.runtimeCapabilitiesSnapshot).includes('must-not-enter-run-snapshot'), false);
  assert.deepEqual(resolved.runtimeCapabilitiesSnapshot.image.models, [{ id: 'image-main', label: 'Image Main' }]);
});

test('space config: 自动加入必需业务插件依赖但不自动加入可选依赖', async () => {
  const required = structuredClone(businessPlugin);
  required.manifest.id = 'required';
  required.manifest.displayName = 'Required';
  required.contentHash = 'b'.repeat(64);
  const optional = structuredClone(businessPlugin);
  optional.manifest.id = 'optional';
  optional.manifest.displayName = 'Optional';
  optional.contentHash = 'c'.repeat(64);
  const dependent = structuredClone(businessPlugin);
  dependent.manifest.schemaVersion = 2;
  dependent.manifest.id = 'dependent';
  dependent.manifest.displayName = 'Dependent';
  dependent.contentHash = 'd'.repeat(64);
  dependent.manifest.dependencies = [
    { id: 'required' },
    { id: 'optional', optional: true },
  ];
  const definitions = [required, optional, dependent];
  const service = new SpaceConfigService(async () => ({
    ...structuredClone(catalog),
    businessPluginIds: definitions.map((definition) => definition.manifest.id),
    businessPlugins: definitions.map((definition) => ({
      id: definition.manifest.id,
      label: definition.manifest.displayName,
      description: definition.manifest.description,
      contentHash: definition.contentHash,
      dependencies: (definition.manifest.dependencies ?? [])
        .filter((dependency) => !dependency.optional)
        .map((dependency) => dependency.id),
    })),
    businessPluginDefinitions: definitions,
    businessPluginConfigs: Object.fromEntries(definitions.map((definition) => [definition.manifest.id, {}])),
  }));

  const options = await service.options('tn_config');
  assert.deepEqual(options.businessPlugins.find((plugin) => plugin.id === 'dependent')?.dependencies, ['required']);
  const saved = await service.snapshotForCreate('tn_config', 'web', {
    capabilities: { businessPlugins: ['dependent'] },
  });
  assert.deepEqual(saved.capabilities.businessPlugins, ['required', 'dependent']);
});

test('space config: 空间预算只有进一步收紧模型阈值时才成为有效来源', async () => {
  const service = configService();
  const space = {
    id: 'sp_tighter_budget',
    tenant_id: 'tn_config',
    mode: 'web' as const,
    name: 'Tighter Budget',
    execution_user_id: null,
    config: await service.snapshotForCreate('tn_config', 'web', { model: { contextBudget: 40_000 } }),
    config_version: 1,
    created_by_user_id: null,
    visible_user_ids: [],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };

  const resolved = await service.resolveForRun('tn_config', space);
  assert.equal(resolved.snapshot.model.contextBudget, 40_000);
  assert.equal(resolved.snapshot.model.contextBudgetSource, 'space-config');
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
    service.snapshotForCreate('tn_config', 'web', {
      capabilities: { businessPlugins: ['crm'], runtime: ['image'] },
    }),
    /业务插件所需运行资源未被空间授权：llm/,
  );
  const accepted = await service.snapshotForCreate('tn_config', 'web', {
    capabilities: { businessPlugins: ['crm'], runtime: ['llm'] },
  });
  assert.deepEqual(accepted.capabilities.runtime, ['llm']);

  resourcePlugin.manifest.resources = [{ type: 'image.proxy' }];
  await assert.rejects(
    service.snapshotForCreate('tn_config', 'web', {
      capabilities: { businessPlugins: ['crm'], runtime: ['llm'] },
    }),
    /业务插件所需运行资源未被空间授权：image/,
  );
  const imageAccepted = await service.snapshotForCreate('tn_config', 'web', {
    capabilities: { businessPlugins: ['crm'], runtime: ['image'] },
  });
  assert.deepEqual(imageAccepted.capabilities.runtime, ['image']);
});

test('space config: 系统 instance 预算不能超过模型窗口', async () => {
  const service = new SpaceConfigService(async () => ({
    ...structuredClone(catalog),
    defaultModelRef: 'main:model-small',
    modelRefs: ['main:model-small'],
    modelContexts: { 'main:model-small': { contextWindow: 8_000, compactionThreshold: 8_000 } },
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
      config: await service.snapshotForCreate('tn_config', 'web'),
      config_version: 1,
      created_by_user_id: null,
      visible_user_ids: [],
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
  assert.match((first.space_config_snapshot as unknown as { promptTemplate: string }).promptTemplate, /version one/);
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
  assert.match((second.space_config_snapshot as unknown as { promptTemplate: string }).promptTemplate, /version two/);
  assert.match((first.space_config_snapshot as unknown as { promptTemplate: string }).promptTemplate, /version one/);
});
