import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatHexRows, parseByteRange, previewTextLines } from './files.js';
import { signFileShare, verifyFileShare } from './auth.js';
import { config } from '../config.js';
import { isOfficeConvertiblePath, officePdfCacheKey } from '../files/officePreview.js';
import {
  ensureThreadWorkspaceRoot,
  migrateLegacyBootstrapWorkspace,
  resolveThreadWorkspaceRoot,
  resolveWorkspaceRoot,
  removeTenantWorkspace,
  removeUserWorkspace,
} from '../files/workspaceRoot.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { buildApp, listen, seedOwner } from './testHelpers.js';
import { spaceAccess } from '../spaces/access.js';
import { store } from '../store/index.js';

test('render preview keeps long lines intact', () => {
  const longLine = `const DATA = ${'x'.repeat(13_000)};`;

  const sourceLines = previewTextLines(longLine);
  assert.match(sourceLines[0], /预览已截断/);

  const renderLines = previewTextLines(longLine, { truncateLongLines: false });
  assert.equal(renderLines[0], longLine);
});

test('hex preview formats offset, bytes and ascii columns', () => {
  const rows = formatHexRows(Buffer.from([0x00, 0x20, 0x41, 0x7e, 0x7f]), 16);
  assert.deepEqual(rows, [
    {
      offset: 16,
      hex: '00 20 41 7E 7F',
      ascii: '. A~.',
    },
  ]);
});

test('byte range parser supports browser media requests', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseByteRange('bytes=100-', 100), 'invalid');
});

test('file share signature binds path and expiry', () => {
  const previousAccessToken = config.auth.accessToken;
  const previousShareSecret = config.auth.shareSecret;
  config.auth.accessToken = 'test-access-token';
  config.auth.shareSecret = 'test-share-secret';
  try {
    const expires = 2000;
    const sig = signFileShare('artifacts/report.html', 'default', 'us_a', expires, 'sp_a', 'th_a');

    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires), sig, 'sp_a', 'th_a', 1000), true);
    assert.equal(verifyFileShare('artifacts/other.html', 'default', 'us_a', String(expires), sig, 'sp_a', 'th_a', 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires + 1), sig, 'sp_a', 'th_a', 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires), sig, 'sp_a', 'th_a', 2001), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'other-tenant', 'us_a', String(expires), sig, 'sp_a', 'th_a', 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_b', String(expires), sig, 'sp_a', 'th_a', 1000), false);

    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires), sig, 'sp_b', 'th_a', 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires), sig, 'sp_a', 'th_b', 1000), false);
  } finally {
    config.auth.accessToken = previousAccessToken;
    config.auth.shareSecret = previousShareSecret;
  }
});

test('workspace root is isolated by space and thread', () => {
  const base = '/srv/runforge/workspace';
  assert.equal(resolveWorkspaceRoot({ tenantId: 'default', userId: 'us_a' }, base), '/srv/runforge/workspace/tenants/default/users/us_a/workspace');
  assert.equal(resolveWorkspaceRoot({ tenantId: 'default', userId: 'us_b' }, base), '/srv/runforge/workspace/tenants/default/users/us_b/workspace');
  assert.equal(resolveWorkspaceRoot({ tenantId: 'tn_a', userId: 'us_a' }, base), '/srv/runforge/workspace/tenants/tn_a/users/us_a/workspace');
  assert.notEqual(resolveWorkspaceRoot({ tenantId: 'tn_a', userId: 'us_a' }, base), resolveWorkspaceRoot({ tenantId: 'tn_a', userId: 'us_b' }, base));
  assert.equal(resolveThreadWorkspaceRoot('sp_default', 'th_abc123', base), '/srv/runforge/workspace/sp_default/th_abc123');
  assert.notEqual(
    resolveThreadWorkspaceRoot('sp_a', 'th_abc123', base),
    resolveThreadWorkspaceRoot('sp_b', 'th_abc123', base),
  );
});

test('旧默认租户 workspace 会移动到新租户目录且可以重复执行', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-workspace-migration-'));
  try {
    const source = join(base, 'users', 'us_legacy', 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'note.txt'), 'legacy workspace');

    await migrateLegacyBootstrapWorkspace('tn_migrated', base);
    assert.equal(
      await readFile(join(base, 'tenants', 'tn_migrated', 'users', 'us_legacy', 'workspace', 'note.txt'), 'utf8'),
      'legacy workspace',
    );
    await migrateLegacyBootstrapWorkspace('tn_migrated', base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('旧 thread 工作目录会原子移动到 space/thread 路径', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-thread-workspace-migration-'));
  try {
    const legacy = join(base, 'th_legacy');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'note.txt'), 'legacy thread workspace');
    const target = await ensureThreadWorkspaceRoot('sp_default', 'th_legacy', base);
    assert.equal(target, join(base, 'sp_default', 'th_legacy'));
    assert.equal(await readFile(join(target, 'note.txt'), 'utf8'), 'legacy thread workspace');
    assert.equal(await ensureThreadWorkspaceRoot('sp_default', 'th_legacy', base), target);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('租户和用户旧工作目录支持直接删除', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-workspace-delete-'));
  try {
    const userRoot = join(base, 'tenants', 'tn_delete', 'users', 'us_delete');
    await mkdir(userRoot, { recursive: true });
    await writeFile(join(userRoot, 'note.txt'), 'user workspace');
    await removeUserWorkspace('tn_delete', 'us_delete', base);
    assert.equal(existsSync(userRoot), false);

    const tenantRoot = join(base, 'tenants', 'tn_delete');
    await mkdir(tenantRoot, { recursive: true });
    await removeTenantWorkspace('tn_delete', base);
    assert.equal(existsSync(join(base, 'tenants', 'tn_delete')), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('office pdf preview only accepts office documents', () => {
  assert.equal(isOfficeConvertiblePath('demo.pptx'), true);
  assert.equal(isOfficeConvertiblePath('demo.xlsx'), true);
  assert.equal(isOfficeConvertiblePath('demo.docx'), true);
  assert.equal(isOfficeConvertiblePath('demo.pdf'), false);
});

test('office pdf cache key changes when source metadata changes', () => {
  const base = { tenantId: 'default', workspaceKey: 'user:us_a', remotePath: 'artifacts/demo.pptx', size: 10, mtimeMs: 100, converterUrl: 'http://converter:3000' };
  assert.equal(officePdfCacheKey(base), officePdfCacheKey(base));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, mtimeMs: 101 }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, cacheVersion: 'fonts-v2' }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, tenantId: 'other-tenant' }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, workspaceKey: 'thread:th_b' }));
});

test('file content API saves text with version conflict protection', async () => {
  const previousWorkspaceRoot = config.tools.workspaceRoot;
  const base = await mkdtemp(join(tmpdir(), 'runforge-file-content-'));
  config.tools.workspaceRoot = base;
  try {
    const owner = await seedOwner('tn_file_content', 'owner@file-content.test', 'pw');
    const token = signTenantAccessToken({ id: owner.id, tenantId: 'tn_file_content', role: 'owner' });
    const defaultSpace = await store.getDefaultSpace('tn_file_content');
    assert.ok(defaultSpace);
    const thread = await store.createThread({ tenantId: 'tn_file_content', userId: owner.id }, 'files', { spaceId: defaultSpace.id });
    const root = resolveThreadWorkspaceRoot(defaultSpace.id, thread.id, base);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'plugins', 'crm'), { recursive: true });
    await writeFile(join(root, 'src/demo.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(join(root, 'plugins/crm/readme.md'), '# managed plugin\n', 'utf8');

    const { port, close } = await listen(buildApp());
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const loaded = await fetch(`http://127.0.0.1:${port}/api/files/content?path=src%2Fdemo.ts&threadId=${thread.id}`, { headers });
      assert.equal(loaded.status, 200);
      const body = (await loaded.json()) as { content: string; version: { sha256: string } };
      assert.equal(body.content, 'export const value = 1;\n');

      const saved = await fetch(`http://127.0.0.1:${port}/api/files/content`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'src/demo.ts', content: 'export const value = 2;\n', baseSha256: body.version.sha256, threadId: thread.id }),
      });
      assert.equal(saved.status, 200);
      assert.equal(await readFile(join(root, 'src/demo.ts'), 'utf8'), 'export const value = 2;\n');

      await writeFile(join(root, 'src/demo.ts'), 'export const value = 3;\n', 'utf8');
      const conflict = await fetch(`http://127.0.0.1:${port}/api/files/content`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'src/demo.ts', content: 'export const value = 4;\n', baseSha256: body.version.sha256, threadId: thread.id }),
      });
      assert.equal(conflict.status, 409);
      assert.equal(await readFile(join(root, 'src/demo.ts'), 'utf8'), 'export const value = 3;\n');

      const managed = await fetch(`http://127.0.0.1:${port}/api/files/content?path=plugins%2Fcrm%2Freadme.md&threadId=${thread.id}`, { headers });
      assert.equal(managed.status, 200);
      const managedBody = (await managed.json()) as { version: { sha256: string } };
      const managedWrite = await fetch(`http://127.0.0.1:${port}/api/files/content`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'plugins/crm/readme.md',
          content: '# changed\n',
          baseSha256: managedBody.version.sha256,
          threadId: thread.id,
        }),
      });
      assert.equal(managedWrite.status, 403);
      assert.equal(await readFile(join(root, 'plugins/crm/readme.md'), 'utf8'), '# managed plugin\n');
    } finally {
      close();
    }
  } finally {
    config.tools.workspaceRoot = previousWorkspaceRoot;
    await rm(base, { recursive: true, force: true });
  }
});

test('file API resolves every thread workspace and binds signed links to space/thread', async () => {
  const previousWorkspaceRoot = config.tools.workspaceRoot;
  const previousShareSecret = config.auth.shareSecret;
  const base = await mkdtemp(join(tmpdir(), 'runforge-thread-files-'));
  config.tools.workspaceRoot = base;
  config.auth.shareSecret = 'thread-file-share-secret';
  try {
    const tenantId = 'tn_thread_files';
    const owner = await seedOwner(tenantId, 'owner@thread-files.test', 'pw');
    const otherOwner = await seedOwner('tn_thread_files_other', 'owner@thread-files-other.test', 'pw');
    const ownerIdentity = { scope: 'tenant' as const, tenantId, userId: owner.id, role: 'owner' as const };
    const space = await spaceAccess.create(ownerIdentity, { mode: 'web', name: 'Isolated Files' });
    const scope = { tenantId, userId: owner.id };
    const thread = await store.createThread(scope, 'isolated', { spaceId: space.id });
    const secondThread = await store.createThread(scope, 'isolated-2', { spaceId: space.id });
    const defaultSpace = await store.getDefaultSpace(tenantId);
    assert.ok(defaultSpace);
    const defaultThread = await store.createThread(scope, 'default', { spaceId: defaultSpace.id });

    const threadRoot = resolveThreadWorkspaceRoot(space.id, thread.id, base);
    const secondThreadRoot = resolveThreadWorkspaceRoot(space.id, secondThread.id, base);
    const defaultThreadRoot = resolveThreadWorkspaceRoot(defaultSpace.id, defaultThread.id, base);
    await mkdir(threadRoot, { recursive: true });
    await mkdir(secondThreadRoot, { recursive: true });
    await mkdir(defaultThreadRoot, { recursive: true });
    await writeFile(join(threadRoot, 'same.txt'), 'thread workspace', 'utf8');
    await writeFile(join(secondThreadRoot, 'same.txt'), 'second thread workspace', 'utf8');
    await writeFile(join(defaultThreadRoot, 'same.txt'), 'default thread workspace', 'utf8');

    const ownerToken = signTenantAccessToken({ id: owner.id, tenantId, role: 'owner' });
    const otherToken = signTenantAccessToken({ id: otherOwner.id, tenantId: 'tn_thread_files_other', role: 'owner' });
    const { port, close } = await listen(buildApp());
    const apiBase = `http://127.0.0.1:${port}/api/files`;
    try {
      const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };
      const isolated = await fetch(`${apiBase}/content?path=same.txt&threadId=${thread.id}`, { headers: ownerHeaders });
      assert.equal(isolated.status, 200);
      assert.equal(((await isolated.json()) as { content: string }).content, 'thread workspace');

      const secondIsolated = await fetch(`${apiBase}/content?path=same.txt&threadId=${secondThread.id}`, { headers: ownerHeaders });
      assert.equal(secondIsolated.status, 200);
      assert.equal(((await secondIsolated.json()) as { content: string }).content, 'second thread workspace');

      const legacy = await fetch(`${apiBase}/content?path=same.txt`, { headers: ownerHeaders });
      assert.equal(legacy.status, 409);

      const defaultByThread = await fetch(`${apiBase}/content?path=same.txt&threadId=${defaultThread.id}`, { headers: ownerHeaders });
      assert.equal(defaultByThread.status, 200);
      assert.equal(((await defaultByThread.json()) as { content: string }).content, 'default thread workspace');

      const threadShells = await fetch(`http://127.0.0.1:${port}/api/shell-sessions?threadId=${thread.id}`, { headers: ownerHeaders });
      assert.equal(threadShells.status, 200);
      const threadShellBody = (await threadShells.json()) as { sessions: Array<{ workspace_root: string }> };
      assert.equal(threadShellBody.sessions[0]?.workspace_root, threadRoot);

      const defaultShells = await fetch(`http://127.0.0.1:${port}/api/shell-sessions?threadId=${defaultThread.id}`, { headers: ownerHeaders });
      assert.equal(defaultShells.status, 200);
      const defaultShellBody = (await defaultShells.json()) as { sessions: Array<{ workspace_root: string }> };
      assert.equal(defaultShellBody.sessions[0]?.workspace_root, defaultThreadRoot);

      const crossTenant = await fetch(`${apiBase}/content?path=same.txt&threadId=${thread.id}`, {
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      assert.equal(crossTenant.status, 404);

      const share = await fetch(`${apiBase}/share-link`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'same.txt', threadId: thread.id, ttlSeconds: 600 }),
      });
      assert.equal(share.status, 201);
      const shareBody = (await share.json()) as { rawUrl: string };
      const sharedUrl = new URL(shareBody.rawUrl, `http://127.0.0.1:${port}`);
      assert.equal(sharedUrl.searchParams.get('threadId'), thread.id);
      assert.equal(sharedUrl.searchParams.get('spaceId'), space.id);
      const shared = await fetch(sharedUrl);
      assert.equal(shared.status, 200);
      assert.equal(await shared.text(), 'thread workspace');

      const sharedWhileLoggedInElsewhere = await fetch(sharedUrl, {
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      assert.equal(sharedWhileLoggedInElsewhere.status, 200);
      assert.equal(await sharedWhileLoggedInElsewhere.text(), 'thread workspace');

      sharedUrl.searchParams.set('threadId', secondThread.id);
      const tampered = await fetch(sharedUrl);
      assert.equal(tampered.status, 403);

      const bogusSpaceId = 'sp_invalid_share';
      const bogusThreadId = 'th_invalid_share';
      sharedUrl.searchParams.set('spaceId', bogusSpaceId);
      sharedUrl.searchParams.set('threadId', bogusThreadId);
      const invalidWorkspace = await fetch(sharedUrl);
      assert.equal(invalidWorkspace.status, 403);
      assert.equal(existsSync(resolveThreadWorkspaceRoot(bogusSpaceId, bogusThreadId, base)), false);
    } finally {
      close();
    }
  } finally {
    config.tools.workspaceRoot = previousWorkspaceRoot;
    config.auth.shareSecret = previousShareSecret;
    await rm(base, { recursive: true, force: true });
  }
});
