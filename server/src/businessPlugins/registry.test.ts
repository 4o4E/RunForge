import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { create as createTar } from 'tar';
import { ZipFile } from 'yazl';
import { CordisRuntimeManager } from '../plugins/runtime.js';
import { extractBusinessPluginArchive, normalizedArchivePath } from './archive.js';
import { BusinessPluginError } from './errors.js';
import { createBusinessPluginCordisDefinition, createBusinessPluginSelection } from './cordis.js';
import { BusinessPluginRegistry, loadBusinessPlugin, loadBusinessPluginIndex } from './registry.js';
import { BusinessPluginRuntimeService, resolveBusinessPluginMcpServer } from './runtime.js';
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

async function zipDirectory(root: string): Promise<Buffer> {
  const zip = new ZipFile();
  const add = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const archivePath = relative(root, path).split('\\').join('/');
      if (entry.isDirectory()) await add(path);
      else if (entry.isFile()) zip.addFile(path, archivePath);
    }
  };
  await add(root);
  return finishZip(zip);
}

function finishZip(zip: ZipFile): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

async function tgzDirectory(root: string): Promise<Buffer> {
  const outputRoot = await mkdtemp(join(tmpdir(), 'runforge-business-tgz-'));
  const archivePath = join(outputRoot, 'plugin.tgz');
  await createTar({ cwd: dirname(root), file: archivePath, gzip: true }, [basename(root)]);
  return readFile(archivePath);
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

test('业务插件安装：自动赋予 Skill 脚本和声明命令执行权限', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-permission-source-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-permission-target-'));
  const pluginRoot = await createPlugin(sourceRoot, 'permission-plugin');
  const script = join(pluginRoot, 'skills', 'customer-query', 'scripts', 'run.mjs');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, 'console.log("ok")');
  const executable = join(pluginRoot, 'bin');
  await mkdir(executable, { recursive: true });
  const command = join(executable, 'helper');
  await writeFile(command, '#!/bin/sh\nprintf helper\n');
  await chmod(script, 0o644);
  await chmod(command, 0o644);
  await writeFile(join(pluginRoot, 'runforge.plugin.yaml'), (await readFile(join(pluginRoot, 'runforge.plugin.yaml'), 'utf8'))
    .replace('schemaVersion: 1', 'schemaVersion: 2')
    .replace('secrets:', 'executables:\n  - name: helper\n    path: bin/helper\nsecrets:'));
  const registry = new BusinessPluginRegistry([importRoot]);
  const installed = await registry.importArchive('tn_permission', await tgzDirectory(pluginRoot), 'tgz');
  assert.equal((await stat(join(installed.definition.root, 'skills', 'customer-query', 'scripts', 'run.mjs'))).mode & 0o111, 0o111);
  assert.equal((await stat(join(installed.definition.root, 'bin', 'helper'))).mode & 0o111, 0o111);
});

test('业务插件导入：支持 ZIP 新增和 TGZ 原子覆盖', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-import-source-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-import-target-'));
  const pluginRoot = await createPlugin(sourceRoot, 'crm');
  const registry = new BusinessPluginRegistry([importRoot]);

  const created = await registry.importArchive('tn_import', await zipDirectory(pluginRoot), 'zip');
  assert.equal(created.replaced, false);
  assert.equal(created.definition.manifest.id, 'crm');
  assert.equal(created.definition.root, join(importRoot, 'tn_import', 'crm'));
  assert.equal((await registry.list('tn_import')).length, 1);

  await writeFile(join(pluginRoot, 'skills', 'customer-query', 'references', 'schema.md'), '# Imported v2');
  const updated = await registry.importArchive('tn_import', await tgzDirectory(pluginRoot), 'tgz');
  assert.equal(updated.replaced, true);
  assert.notEqual(updated.definition.contentHash, created.definition.contentHash);
  assert.equal(
    await readFile(join(updated.definition.root, 'skills', 'customer-query', 'references', 'schema.md'), 'utf8'),
    '# Imported v2',
  );
  assert.deepEqual((await registry.list('tn_import')).map((definition) => definition.manifest.id), ['crm']);
});

test('业务插件安装：同名命令只提示，不阻止安装', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-command-conflict-source-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-command-conflict-target-'));
  const first = await createPlugin(sourceRoot, 'first-command', { id: 'first-command' });
  const second = await createPlugin(sourceRoot, 'second-command', { id: 'second-command' });
  for (const root of [first, second]) {
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'helper'), '#!/bin/sh\nprintf helper\n');
    await chmod(join(bin, 'helper'), 0o755);
    await writeFile(join(root, 'runforge.plugin.yaml'), (await readFile(join(root, 'runforge.plugin.yaml'), 'utf8'))
      .replace('schemaVersion: 1', 'schemaVersion: 2')
      .replace('secrets:', 'executables:\n  - name: helper\n    path: bin/helper\nsecrets:'));
  }
  const registry = new BusinessPluginRegistry([importRoot]);
  await registry.importArchive('tn_command_conflict', await tgzDirectory(first), 'tgz');
  const installed = await registry.importArchive('tn_command_conflict', await tgzDirectory(second), 'tgz');
  assert.equal(installed.replaced, false);
  assert.deepEqual(installed.warnings, ['命令 helper 同时由业务插件 first-command 和 second-command 提供']);
  assert.equal((await registry.list('tn_command_conflict')).length, 2);
});

test('业务插件卸载：删除当前部署并保留可恢复旧运行的不可变快照', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-uninstall-source-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-uninstall-target-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-uninstall-workspace-'));
  const pluginRoot = await createPlugin(sourceRoot, 'crm');
  const registry = new BusinessPluginRegistry([importRoot]);
  const imported = await registry.importArchive('tn_business', await zipDirectory(pluginRoot), 'zip');
  const lock = runLock(imported.definition);
  const runtime = new BusinessPluginRuntimeService();
  const handle = await runtime.startRun({
    runId: 'ru_before_uninstall',
    workspaceRoot,
    definitions: [imported.definition],
    lock,
    resolveSecrets: async () => ({ 'crm.api-key': 'same-tenant-secret' }),
  });
  await handle.dispose();
  await runtime.dispose();

  const snapshotRoot = join(
    importRoot,
    'tn_business',
    '.runforge-snapshots',
    'crm',
    imported.definition.contentHash,
    'plugin',
  );
  assert.equal(existsSync(snapshotRoot), true);

  await registry.uninstall('tn_business', 'crm');
  assert.equal(existsSync(imported.definition.root), false);
  assert.equal(existsSync(snapshotRoot), true);
  assert.deepEqual(await registry.list('tn_business'), []);
  assert.deepEqual(
    (await new BusinessPluginRegistry([importRoot]).resolveLock('tn_business', lock)).map((item) => item.contentHash),
    [imported.definition.contentHash],
  );
});

test('业务插件卸载：tenant 修改锁覆盖配置清理和部署删除的完整区间', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-uninstall-lock-source-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-uninstall-lock-target-'));
  const pluginRoot = await createPlugin(sourceRoot, 'crm');
  const registry = new BusinessPluginRegistry([importRoot]);
  await registry.importArchive('tn_business_lock', await zipDirectory(pluginRoot), 'zip');

  const events: string[] = [];
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let cleanupStarted!: () => void;
  const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  const uninstalling = registry.uninstall('tn_business_lock', 'crm', async () => {
    events.push('cleanup-start');
    cleanupStarted();
    await cleanupGate;
    events.push('cleanup-end');
  });
  await started;
  const savingSpace = registry.mutateTenant('tn_business_lock', async () => {
    events.push('space-save');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['cleanup-start']);
  releaseCleanup();
  await Promise.all([uninstalling, savingSpace]);
  assert.deepEqual(events, ['cleanup-start', 'cleanup-end', 'space-save']);
});

test('租户删除：数据库删除成功后清理插件目录，失败时保留目录', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-tenant-delete-source-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-tenant-delete-target-'));
  const pluginRoot = await createPlugin(sourceRoot, 'crm');
  const registry = new BusinessPluginRegistry([importRoot]);
  await registry.importArchive('tn_delete_success', await zipDirectory(pluginRoot), 'zip');
  await registry.deleteTenant('tn_delete_success', async () => 'deleted');
  assert.equal(existsSync(join(importRoot, 'tn_delete_success')), false);

  await registry.importArchive('tn_delete_rollback', await zipDirectory(pluginRoot), 'zip');
  await assert.rejects(
    registry.deleteTenant('tn_delete_rollback', async () => {
      throw new Error('数据库删除失败');
    }),
    /数据库删除失败/,
  );
  assert.equal(existsSync(join(importRoot, 'tn_delete_rollback', 'crm')), true);
});

test('业务插件导入：无效更新保持当前版本，链接和路径穿越被拒绝', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-import-invalid-source-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-import-invalid-target-'));
  const pluginRoot = await createPlugin(sourceRoot, 'crm');
  const registry = new BusinessPluginRegistry([importRoot]);
  const current = await registry.importArchive('tn_import_invalid', await zipDirectory(pluginRoot), 'zip');

  await writeFile(join(pluginRoot, 'skills', 'customer-query', 'SKILL.md'), [
    '---',
    'name: wrong-name',
    'description: Invalid update.',
    '---',
    '# Invalid',
  ].join('\n'));
  await assert.rejects(registry.importArchive('tn_import_invalid', await zipDirectory(pluginRoot), 'zip'), /不一致/);
  assert.equal((await registry.list('tn_import_invalid'))[0]?.contentHash, current.definition.contentHash);

  const symlinkRoot = await createPlugin(sourceRoot, 'linked');
  await symlink('/tmp', join(symlinkRoot, 'outside'));
  await assert.rejects(
    registry.importArchive('tn_import_invalid', await tgzDirectory(symlinkRoot), 'tgz'),
    /只允许普通文件和目录/,
  );

  const symlinkZip = new ZipFile();
  symlinkZip.addBuffer(Buffer.from('/tmp'), 'outside', { mode: 0o120777 });
  await assert.rejects(
    extractBusinessPluginArchive(await finishZip(symlinkZip), 'zip', tmpdir()),
    /ZIP 不允许符号链接/,
  );
  assert.throws(() => normalizedArchivePath('../outside'), /非法路径/);
  assert.throws(() => normalizedArchivePath('C:\\outside'), /非法路径/);

  const traversalZip = new ZipFile();
  traversalZip.addBuffer(Buffer.from('outside'), 'aa/file');
  const malicious = await finishZip(traversalZip);
  const safeName = Buffer.from('aa/file');
  const unsafeName = Buffer.from('../file');
  let cursor = 0;
  let replacements = 0;
  while ((cursor = malicious.indexOf(safeName, cursor)) >= 0) {
    unsafeName.copy(malicious, cursor);
    cursor += unsafeName.length;
    replacements += 1;
  }
  assert.equal(replacements, 2);
  await assert.rejects(
    extractBusinessPluginArchive(malicious, 'zip', tmpdir()),
    (error: unknown) => error instanceof BusinessPluginError && error.code === 'BUSINESS_PLUGIN_ARCHIVE_INVALID',
  );
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

  const legacyExecutable = await createPlugin(sourceRoot, 'legacy-executable');
  await writeFile(join(legacyExecutable, 'runforge.plugin.yaml'), (await readFile(join(legacyExecutable, 'runforge.plugin.yaml'), 'utf8'))
    .replace('secrets:', 'executables:\n  - name: helper\n    path: bin/helper\nsecrets:'));
  await assert.rejects(loadBusinessPlugin(legacyExecutable), /必须声明 schemaVersion: 2/);

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

test('业务插件可用性：必需依赖缺失或版本不符时直接显示不可用', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-business-readiness-source-'));
  const base = await createPlugin(sourceRoot, 'base', { id: 'base' });
  await writeFile(join(base, 'runforge.plugin.yaml'), (await readFile(join(base, 'runforge.plugin.yaml'), 'utf8'))
    .replace('schemaVersion: 1', 'schemaVersion: 2')
    .replace('secrets:', 'version: 1.0.0\nsecrets:'));
  const dependent = await createPlugin(sourceRoot, 'dependent', { id: 'dependent' });
  await writeFile(join(dependent, 'runforge.plugin.yaml'), (await readFile(join(dependent, 'runforge.plugin.yaml'), 'utf8'))
    .replace('schemaVersion: 1', 'schemaVersion: 2')
    .replace('secrets:', 'dependencies:\n  - id: base\n    version: 2.0.0\nsecrets:'));
  const definitions = [await loadBusinessPlugin(base), await loadBusinessPlugin(dependent)];
  const readiness = businessPluginReadiness(definitions, normalizeBusinessPluginTenantSettings({ secrets: { 'crm.api-key': 'x' } }));
  assert.equal(readiness.find((item) => item.definition.manifest.id === 'dependent')?.ready, false);
  assert.match(readiness.find((item) => item.definition.manifest.id === 'dependent')?.error ?? '', /版本/);
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
  assert.equal(handle.skills[0]?.root, join(workspaceRoot, 'plugins', 'crm', 'skills', 'customer-query'));
  assert.equal(existsSync(join(handle.skills[0]!.root, 'references', 'schema.md')), true);
  await writeFile(join(handle.skills[0]!.root, 'references', 'schema.md'), '# workspace changed');
  assert.equal(
    await readFile(join(sourceRoot, '.runforge-snapshots', 'crm', definition.contentHash, 'plugin', 'skills', 'customer-query', 'references', 'schema.md'), 'utf8'),
    '# Customer schema',
  );
  assert.equal(handle.mcpServers[0]?.bearerToken, '');
  const debugServer = resolveBusinessPluginMcpServer(
    definition,
    'crm',
    {},
    { 'crm.api-key': 'same-tenant-secret' },
  );
  assert.equal(debugServer.id, 'business-crm-crm');
  assert.equal(debugServer.bearerToken, 'same-tenant-secret');
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
  await writeFile(join(pluginRoot, 'skills', 'customer-query', 'SKILL.md'), [
    '---',
    'name: customer-query',
    'description: Query the reviewed customer business system.',
    '---',
    '# Customer query v2',
  ].join('\n'));
  const cached = await registry.list('tn_left');
  assert.equal(cached[0]?.contentHash, first[0]?.contentHash);
  assert.equal((await businessPluginAdminView(cached, normalizeBusinessPluginTenantSettings({}))).plugins[0]?.skills[0]?.content, '# Customer query');
  const reloaded = await registry.reload('tn_left');
  assert.notEqual(reloaded[0]?.contentHash, first[0]?.contentHash);
  assert.equal((await businessPluginAdminView(reloaded, normalizeBusinessPluginTenantSettings({}))).plugins[0]?.skills[0]?.content, '# Customer query v2');
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
    'skills:',
    '  - id: customer-query',
    '    path: skills/customer-query',
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
  assert.equal(view.plugins[0]?.skills[0]?.name, 'customer-query');
  assert.equal(view.plugins[0]?.skills[0]?.description, 'Query the reviewed customer business system.');
  assert.equal(view.plugins[0]?.skills[0]?.content, '# Customer query');
  assert.equal(view.plugins[0]?.mcpServers[0]?.transport, 'streamable-http');
  assert.equal(view.plugins[0]?.mcpServers[0]?.urlConfigKey, 'endpoint');
  assert.equal(view.plugins[0]?.mcpServers[0]?.bearerSecretKey, 'crm.api-key');
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
