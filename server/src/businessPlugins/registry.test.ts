import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CordisRuntimeManager } from '../plugins/runtime.js';
import { BusinessPluginError } from './errors.js';
import { createBusinessPluginCordisDefinition, createBusinessPluginSelection } from './cordis.js';
import { BusinessPluginRegistry, loadBusinessPlugin, loadBusinessPluginIndex } from './registry.js';
import { BusinessPluginRuntimeService } from './runtime.js';
import { businessPluginAdminView, businessPluginReadiness, normalizeBusinessPluginTenantSettings } from './settings.js';
import { createSpaceRuntimeLock } from '../plugins/lock.js';

function runLock(definition: Awaited<ReturnType<typeof loadBusinessPlugin>>) {
  return createSpaceRuntimeLock({
    tenantId: 'tn_business',
    spaceId: 'sp_business',
    configVersion: 1,
    plugins: [createBusinessPluginSelection(definition)],
  });
}

async function createPlugin(
  sourceRoot: string,
  directory: string,
  options: { id?: string; description?: string; extra?: string } = {},
): Promise<string> {
  const root = join(sourceRoot, directory);
  const skillRoot = join(root, 'skills', 'customer-query');
  await mkdir(join(skillRoot, 'references'), { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), [
    '---',
    'name: customer-query',
    'description: Query the reviewed customer business system.',
    '---',
    '# Customer query',
  ].join('\n'));
  await writeFile(join(skillRoot, 'references', 'schema.md'), options.extra ?? '# Customer schema');
  await writeFile(join(root, 'runforge.plugin.yaml'), [
    'schemaVersion: 1',
    `id: ${options.id ?? directory}`,
    `displayName: ${directory}`,
    `description: ${options.description ?? 'Reviewed business capability.'}`,
    'skills:',
    '  - id: customer-query',
    '    path: skills/customer-query',
    'secrets:',
    '  - key: crm.api-key',
    'mcpServers:',
    '  - id: crm',
    '    url: https://mcp.example.test/api',
    '    bearerSecretKey: crm.api-key',
    'resources:',
    '  - type: database.readonly',
  ].join('\n'));
  return root;
}

test('业务插件协议：发现多文件 Skill、MCP、Secret 和运行资源并生成稳定 hash', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-plugins-'));
  const root = await createPlugin(sourceRoot, 'crm');
  const first = await loadBusinessPlugin(root);

  assert.equal(first.manifest.id, 'crm');
  assert.equal(first.manifest.skills[0]?.path, 'skills/customer-query');
  assert.equal(first.manifest.mcpServers[0]?.bearerSecretKey, 'crm.api-key');
  assert.equal(first.manifest.resources[0]?.type, 'database.readonly');
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);

  await writeFile(join(root, 'skills', 'customer-query', 'references', 'schema.md'), '# Changed schema');
  const second = await loadBusinessPlugin(root);
  assert.notEqual(second.contentHash, first.contentHash);
});

test('业务插件协议：拒绝未声明 Secret、symlink、服务端入口和重复 ID', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-invalid-'));
  const missingSecret = await createPlugin(sourceRoot, 'missing-secret');
  await writeFile(join(missingSecret, 'runforge.plugin.yaml'), [
    'schemaVersion: 1',
    'id: missing-secret',
    'description: Invalid secret reference.',
    'mcpServers:',
    '  - id: crm',
    '    url: https://mcp.example.test/api',
    '    bearerSecretKey: undeclared.key',
  ].join('\n'));
  await assert.rejects(
    loadBusinessPlugin(missingSecret),
    (error: unknown) => error instanceof BusinessPluginError && error.code === 'BUSINESS_PLUGIN_SECRET_MISSING',
  );

  const symlinkPlugin = await createPlugin(sourceRoot, 'symlink-plugin');
  await symlink('/tmp', join(symlinkPlugin, 'skills', 'customer-query', 'references', 'outside'));
  await assert.rejects(
    loadBusinessPlugin(symlinkPlugin),
    (error: unknown) => error instanceof BusinessPluginError && error.code === 'BUSINESS_PLUGIN_PATH_INVALID',
  );

  const runtimePlugin = await createPlugin(sourceRoot, 'runtime-plugin');
  await mkdir(join(runtimePlugin, 'dist'), { recursive: true });
  await writeFile(join(runtimePlugin, 'dist', 'index.js'), 'export default {}');
  await assert.rejects(loadBusinessPlugin(runtimePlugin), /不能包含 RunForge\/Cordis 运行时入口/);

  await createPlugin(sourceRoot, 'duplicate-a', { id: 'duplicate' });
  await createPlugin(sourceRoot, 'duplicate-b', { id: 'duplicate' });
  await assert.rejects(
    loadBusinessPluginIndex([sourceRoot]),
    (error: unknown) => error instanceof BusinessPluginError && error.code === 'BUSINESS_PLUGIN_DUPLICATE_ID',
  );
});

test('业务插件协议：敏感 MCP header 只能引用 tenant Secret，且 header 名称不区分大小写去重', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-headers-'));
  const plaintext = await createPlugin(sourceRoot, 'plaintext-header');
  await writeFile(join(plaintext, 'runforge.plugin.yaml'), [
    'schemaVersion: 1',
    'id: plaintext-header',
    'description: Invalid plaintext header.',
    'mcpServers:',
    '  - id: crm',
    '    url: https://mcp.example.test/api',
    '    headers:',
    '      - name: Authorization',
    '        value: Bearer must-not-live-in-manifest',
  ].join('\n'));
  await assert.rejects(loadBusinessPlugin(plaintext), /必须通过 secretKey 引用 tenant Secret/);

  const duplicate = await createPlugin(sourceRoot, 'duplicate-header');
  await writeFile(join(duplicate, 'runforge.plugin.yaml'), [
    'schemaVersion: 1',
    'id: duplicate-header',
    'description: Invalid duplicate header.',
    'mcpServers:',
    '  - id: crm',
    '    url: https://mcp.example.test/api',
    '    headers:',
    '      - name: X-Region',
    '        value: cn',
    '      - name: x-region',
    '        value: us',
  ].join('\n'));
  await assert.rejects(loadBusinessPlugin(duplicate), /header 不能重复声明/);

  const credentialUrl = await createPlugin(sourceRoot, 'credential-url');
  await writeFile(join(credentialUrl, 'runforge.plugin.yaml'), [
    'schemaVersion: 1',
    'id: credential-url',
    'description: Invalid URL credentials.',
    'mcpServers:',
    '  - id: crm',
    '    url: https://user:password@mcp.example.test/api',
  ].join('\n'));
  await assert.rejects(loadBusinessPlugin(credentialUrl), /不能包含用户名或密码/);
});

test('业务插件协议：由 RunForge 通用 Cordis definition 注册声明能力，不加载业务代码', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-cordis-'));
  const definition = await loadBusinessPlugin(await createPlugin(sourceRoot, 'crm'));
  const manager = new CordisRuntimeManager();
  manager.registerPlugin(createBusinessPluginCordisDefinition(definition));

  const handle = await manager.startRun('ru_business', {
    tenantId: 'tn_business',
    spaceId: 'sp_business',
    configVersion: 1,
    plugins: [createBusinessPluginSelection(definition)],
  });
  assert.deepEqual(handle.catalog.skills.map((item) => item.id), ['business:crm/skill/customer-query']);
  assert.deepEqual(handle.catalog.mcpServers.map((item) => item.id), ['business:crm/mcp/crm']);
  assert.deepEqual(handle.catalog.capabilities.map((item) => item.id), ['business.crm.resource.database.readonly']);
  assert.equal(handle.catalog.skills[0]?.ownerPluginId, 'business.crm');

  await handle.dispose();
  await manager.dispose();
});

test('业务插件运行时：materialize 多文件 Skill，并通过 tenant resolver 解析同一 Secret key', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-runtime-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-workspace-'));
  const definition = await loadBusinessPlugin(await createPlugin(sourceRoot, 'crm'));
  const runtime = new BusinessPluginRuntimeService();
  const requested: string[] = [];
  let currentSecret = 'same-tenant-secret';
  const handle = await runtime.startRun({
    runId: 'ru_business_runtime',
    workspaceRoot,
    definitions: [definition],
    lock: runLock(definition),
    resolveSecrets: async ({ keys }) => {
      requested.push(keys.join(','));
      return { 'crm.api-key': currentSecret };
    },
  });

  assert.equal(handle.skills[0]?.source, 'business');
  assert.equal(handle.skills[0]?.id, 'business:crm/customer-query');
  assert.equal(existsSync(join(handle.skills[0]!.root, 'references', 'schema.md')), true);
  assert.equal(handle.mcpServers[0]?.bearerToken, '');
  assert.deepEqual(requested, []);
  assert.equal((await handle.refreshMcpServers())[0]?.bearerToken, 'same-tenant-secret');
  assert.deepEqual(requested, ['crm.api-key']);
  currentSecret = 'rotated-tenant-secret';
  assert.equal((await handle.refreshMcpServers())[0]?.bearerToken, 'rotated-tenant-secret');
  assert.deepEqual(requested, ['crm.api-key', 'crm.api-key']);

  await handle.dispose();
  await runtime.dispose();
});

test('业务插件运行时：Skill 的协议 ID 不依赖目录名', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-skill-path-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-skill-workspace-'));
  const root = await createPlugin(sourceRoot, 'crm');
  await rename(join(root, 'skills', 'customer-query'), join(root, 'skills', 'query-v1'));
  const manifestPath = join(root, 'runforge.plugin.yaml');
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, 'utf8')).replace('path: skills/customer-query', 'path: skills/query-v1'),
  );
  const definition = await loadBusinessPlugin(root);
  const runtime = new BusinessPluginRuntimeService();
  const handle = await runtime.startRun({
    runId: 'ru_business_skill_path',
    workspaceRoot,
    definitions: [definition],
    lock: runLock(definition),
    resolveSecrets: async () => ({ 'crm.api-key': 'same-tenant-secret' }),
  });

  assert.equal(handle.skills[0]?.name, 'customer-query');
  assert.equal(handle.skills[0]?.id, 'business:crm/customer-query');
  assert.equal(handle.skills[0]?.root.endsWith('/skills/query-v1'), true);
  await handle.dispose();
  await runtime.dispose();
});

test('业务插件发现：tenant 目录隔离，只有显式 reload 才切换当前内容', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-tenant-roots-'));
  const tenantRoot = join(sourceRoot, 'tn_left');
  await mkdir(tenantRoot, { recursive: true });
  const pluginRoot = await createPlugin(tenantRoot, 'crm');
  const registry = new BusinessPluginRegistry([sourceRoot]);

  const first = await registry.list('tn_left');
  assert.equal(first.length, 1);
  assert.deepEqual(await registry.list('tn_right'), []);
  await writeFile(join(pluginRoot, 'skills', 'customer-query', 'references', 'schema.md'), '# v2');
  assert.equal((await registry.list('tn_left'))[0]?.contentHash, first[0]?.contentHash);
  assert.notEqual((await registry.reload('tn_left'))[0]?.contentHash, first[0]?.contentHash);
});

test('业务插件发现：拒绝 tenant 目录通过 symlink 逃逸配置根目录', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-tenant-boundary-'));
  const outside = await mkdtemp(join(tmpdir(), 'runforge-business-tenant-outside-'));
  await createPlugin(outside, 'crm');
  await symlink(outside, join(sourceRoot, 'tn_escape'));
  const registry = new BusinessPluginRegistry([sourceRoot]);

  await assert.rejects(
    registry.list('tn_escape'),
    (error: unknown) => error instanceof BusinessPluginError && error.code === 'BUSINESS_PLUGIN_PATH_INVALID',
  );
});

test('业务插件配置：JSON Schema、MCP endpoint 和 tenant Secret 共同决定是否可用', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-readiness-'));
  const root = await createPlugin(sourceRoot, 'crm');
  await writeFile(join(root, 'runforge.plugin.yaml'), [
    'schemaVersion: 1',
    'id: crm',
    'description: Reviewed business capability.',
    'configSchema:',
    '  type: object',
    '  required: [endpoint]',
    '  properties:',
    '    endpoint: { type: string, minLength: 1 }',
    'secrets:',
    '  - key: crm.api-key',
    'mcpServers:',
    '  - id: crm',
    '    urlConfigKey: endpoint',
    '    bearerSecretKey: crm.api-key',
  ].join('\n'));
  const definition = await loadBusinessPlugin(root);
  const missing = businessPluginReadiness([definition], normalizeBusinessPluginTenantSettings({}))[0];
  assert.equal(missing?.ready, false);
  assert.match(missing?.error ?? '', /endpoint/);

  const ready = businessPluginReadiness([definition], normalizeBusinessPluginTenantSettings({
    schemaVersion: 1,
    plugins: { crm: { config: { endpoint: 'https://mcp.example.test' } } },
    secrets: { 'crm.api-key': 'same-tenant-secret' },
  }))[0];
  assert.equal(ready?.ready, true);
  const credentialUrl = businessPluginReadiness([definition], normalizeBusinessPluginTenantSettings({
    schemaVersion: 1,
    plugins: { crm: { config: { endpoint: 'https://user:password@mcp.example.test' } } },
    secrets: { 'crm.api-key': 'same-tenant-secret' },
  }))[0];
  assert.equal(credentialUrl?.ready, false);
  assert.match(credentialUrl?.error ?? '', /不能包含用户名或密码/);
  const view = businessPluginAdminView([definition], normalizeBusinessPluginTenantSettings({
    schemaVersion: 1,
    plugins: { crm: { config: { endpoint: 'https://mcp.example.test' } } },
    secrets: { 'crm.api-key': 'same-tenant-secret' },
  }));
  assert.equal(view.plugins[0]?.secrets[0]?.configured, true);
  assert.equal(JSON.stringify(view).includes('same-tenant-secret'), false);
});

test('业务插件运行时：run 副本在源目录更新后仍按旧 hash 恢复', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-stable-run-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-stable-workspace-'));
  const root = await createPlugin(sourceRoot, 'crm');
  const original = await loadBusinessPlugin(root);
  const oldLock = runLock(original);
  const firstRuntime = new BusinessPluginRuntimeService();
  const first = await firstRuntime.startRun({
    runId: 'ru_old_first',
    workspaceRoot,
    definitions: [original],
    lock: oldLock,
    resolveSecrets: async () => ({ 'crm.api-key': 'same-tenant-secret' }),
  });
  await first.dispose();
  await firstRuntime.dispose();

  await writeFile(join(root, 'skills', 'customer-query', 'references', 'schema.md'), '# new deployment');
  const updated = await loadBusinessPlugin(root);
  assert.notEqual(updated.contentHash, original.contentHash);

  const recoveredRuntime = new BusinessPluginRuntimeService();
  const recovered = await recoveredRuntime.startRun({
    runId: 'ru_old_recovered',
    workspaceRoot,
    definitions: [updated],
    lock: oldLock,
    resolveSecrets: async () => ({ 'crm.api-key': 'same-tenant-secret' }),
  });
  assert.equal(recovered.skills[0]?.hash, first.skills[0]?.hash);
  assert.equal(
    await readFile(join(recovered.skills[0]!.root, 'references', 'schema.md'), 'utf8'),
    '# Customer schema',
  );
  await recovered.dispose();
  await recoveredRuntime.dispose();
});
