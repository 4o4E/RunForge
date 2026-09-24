import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  resolveSpaceWorkspaceRoot,
  resolveWorkspaceRoot,
  resolveUserFilesRoot,
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
  assert.equal(resolveSpaceWorkspaceRoot('sp_default', base), '/srv/runforge/workspace/sp_default');
  assert.equal(resolveThreadWorkspaceRoot('sp_default', 'th_abc123', base), '/srv/runforge/workspace/sp_default/c/th_abc123');
  assert.notEqual(
    resolveThreadWorkspaceRoot('sp_a', 'th_abc123', base),
    resolveThreadWorkspaceRoot('sp_b', 'th_abc123', base),
  );
  assert.equal(resolveUserFilesRoot('us_a', '/srv/runforge/users'), '/srv/runforge/users/us_a');
});

test('用户文件接口只访问登录用户目录并拒绝目录逃逸', async () => {
  const previousUserFilesRoot = config.tools.userFilesRoot;
  const base = await mkdtemp(join(tmpdir(), 'runforge-user-files-'));
  config.tools.userFilesRoot = base;
  try {
    const tenantId = 'tn_user_files_api';
    const owner = await seedOwner(tenantId, 'owner@user-files.test', 'pw');
    const other = await store.createUser({ tenantId, email: 'other@user-files.test', passwordHash: 'test', role: 'member' });
    const ownerToken = signTenantAccessToken({ id: owner.id, tenantId, role: 'owner' });
    const otherToken = signTenantAccessToken({ id: other.id, tenantId, role: 'member' });
    const { port, close } = await listen(buildApp());
    const apiBase = `http://127.0.0.1:${port}/api/files`;
    try {
      const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };
      const upload = await fetch(`${apiBase}/upload`, {
        method: 'POST', headers: ownerHeaders,
        body: JSON.stringify({ location: 'user', path: 'notes.txt', contentBase64: Buffer.from('个人资料').toString('base64') }),
      });
      assert.equal(upload.status, 201);
      assert.equal(await readFile(join(base, owner.id, 'notes.txt'), 'utf8'), '个人资料');
      const form = new FormData();
      form.append('path', 'media/sample.bin');
      form.append('threadId', '');
      form.append('location', 'user');
      form.append('file', new Blob([Buffer.from([0, 1, 2, 255])]), 'sample.bin');
      const streamed = await fetch(`${apiBase}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: form });
      assert.equal(streamed.status, 201, await streamed.clone().text());
      assert.deepEqual(await readFile(join(base, owner.id, 'media', 'sample.bin')), Buffer.from([0, 1, 2, 255]));
      const largeContent = Buffer.alloc(50 * 1024 * 1024 + 1, 0x5a);
      const largeForm = new FormData();
      largeForm.append('path', 'media/large.bin');
      largeForm.append('threadId', '');
      largeForm.append('location', 'user');
      largeForm.append('file', new Blob([largeContent]), 'large.bin');
      const largeUpload = await fetch(`${apiBase}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: largeForm });
      assert.equal(largeUpload.status, 201);
      assert.equal((await largeUpload.json() as { size: number }).size, largeContent.length);
      const largeDownload = await fetch(`${apiBase}/raw?location=user&path=media%2Flarge.bin`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(largeDownload.status, 200);
      const downloadedLargeContent = Buffer.from(await largeDownload.arrayBuffer());
      assert.equal(downloadedLargeContent.length, largeContent.length);
      assert.equal(downloadedLargeContent[0], 0x5a);
      assert.equal(downloadedLargeContent.at(-1), 0x5a);
      const outOfOrderBoundary = 'runforge-order-check';
      const outOfOrderBody = [
        `--${outOfOrderBoundary}\r\nContent-Disposition: form-data; name="file"; filename="bad.bin"\r\nContent-Type: application/octet-stream\r\n\r\npartial`,
        `\r\n--${outOfOrderBoundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nmedia/bad.bin`,
        `\r\n--${outOfOrderBoundary}\r\nContent-Disposition: form-data; name="threadId"\r\n\r\n`,
        `\r\n--${outOfOrderBoundary}\r\nContent-Disposition: form-data; name="location"\r\n\r\nuser\r\n--${outOfOrderBoundary}--\r\n`,
      ].join('');
      const outOfOrder = await fetch(`${apiBase}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': `multipart/form-data; boundary=${outOfOrderBoundary}` },
        body: outOfOrderBody,
      });
      assert.equal(outOfOrder.status, 400);
      assert.equal(existsSync(join(base, owner.id, 'media', 'bad.bin')), false);
      assert.deepEqual((await readdir(join(base, owner.id, 'media'))).sort(), ['large.bin', 'sample.bin']);
      const mediaPath = join(base, owner.id, 'media');
      const interruptBoundary = 'runforge-interrupt-check';
      const interruptedRequest = httpRequest(`http://127.0.0.1:${port}${apiBase.slice(apiBase.indexOf('/api'))}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': `multipart/form-data; boundary=${interruptBoundary}` },
      });
      interruptedRequest.on('error', () => undefined);
      interruptedRequest.write([
        `--${interruptBoundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nmedia/sample.bin`,
        `\r\n--${interruptBoundary}\r\nContent-Disposition: form-data; name="threadId"\r\n\r\n`,
        `\r\n--${interruptBoundary}\r\nContent-Disposition: form-data; name="location"\r\n\r\nuser`,
        `\r\n--${interruptBoundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.bin"\r\nContent-Type: application/octet-stream\r\n\r\nreplacement-start`,
      ].join(''));
      let temporaryFileAppeared = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if ((await readdir(mediaPath)).some((name) => name.endsWith('.upload'))) {
          temporaryFileAppeared = true;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      assert.equal(temporaryFileAppeared, true);
      interruptedRequest.destroy();
      let temporaryFileRemains = true;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        temporaryFileRemains = (await readdir(mediaPath)).some((name) => name.endsWith('.upload'));
        if (!temporaryFileRemains) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      assert.equal(temporaryFileRemains, false);
      assert.deepEqual(await readFile(join(mediaPath, 'sample.bin')), Buffer.from([0, 1, 2, 255]));
      let oversizedRequest: ReturnType<typeof httpRequest> | undefined;
      const oversizedResponse = await new Promise<{ status: number; body: string }>((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => {
          oversizedRequest?.destroy();
          rejectResponse(new Error('超限上传请求未及时响应'));
        }, 5000);
        oversizedRequest = httpRequest(`http://127.0.0.1:${port}${apiBase.slice(apiBase.indexOf('/api'))}/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'multipart/form-data; boundary=runforge-large-check',
            'Content-Length': String(1024 * 1024 * 1024 + 64 * 1024 + 1),
          },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => {
            clearTimeout(timeout);
            resolveResponse({ status: response.statusCode ?? 0, body });
          });
        });
        oversizedRequest.on('error', (error) => {
          clearTimeout(timeout);
          rejectResponse(error);
        });
        oversizedRequest.flushHeaders();
      });
      assert.equal(oversizedResponse.status, 413);
      assert.equal(oversizedResponse.body.includes('上传上限'), true);
      assert.deepEqual(await readFile(join(mediaPath, 'sample.bin')), Buffer.from([0, 1, 2, 255]));
      assert.deepEqual((await readdir(mediaPath)).sort(), ['large.bin', 'sample.bin']);
      const ownerRead = await fetch(`${apiBase}/content?location=user&path=notes.txt`, { headers: ownerHeaders });
      assert.equal(ownerRead.status, 200);
      const share = await fetch(`${apiBase}/share-link`, {
        method: 'POST', headers: ownerHeaders,
        body: JSON.stringify({ location: 'user', path: 'notes.txt', ttlSeconds: 300 }),
      });
      assert.equal(share.status, 201);
      const shareBody = await share.json() as { rawUrl: string };
      const sharedRead = await fetch(`http://127.0.0.1:${port}${shareBody.rawUrl}`);
      assert.equal(sharedRead.status, 200);
      assert.equal(await sharedRead.text(), '个人资料');
      const otherHeaders = { Authorization: `Bearer ${otherToken}` };
      const altered = new URL(shareBody.rawUrl, `http://127.0.0.1:${port}`);
      altered.searchParams.set('user', other.id);
      assert.equal((await fetch(altered)).status, 403);
      const otherList = await fetch(`${apiBase}/list?location=user&path=.`, { headers: otherHeaders });
      assert.equal(otherList.status, 200);
      assert.deepEqual((await otherList.json() as { entries: unknown[] }).entries, []);
      const escaped = await fetch(`${apiBase}/content?location=user&path=${encodeURIComponent(`../${owner.id}/notes.txt`)}`, { headers: otherHeaders });
      assert.equal(escaped.status, 400);
      await symlink(join(base, owner.id, 'notes.txt'), join(base, other.id, 'linked.txt'));
      const linked = await fetch(`${apiBase}/content?location=user&path=linked.txt`, { headers: otherHeaders });
      assert.equal(linked.status, 403);
    } finally {
      close();
    }
  } finally {
    config.tools.userFilesRoot = previousUserFilesRoot;
    await rm(base, { recursive: true, force: true });
  }
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

test('旧 thread 文件不自动搬入新目录', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-thread-workspace-migration-'));
  try {
    const legacy = join(base, 'sp_default', 'th_legacy');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'note.txt'), 'legacy thread workspace');
    const target = await ensureThreadWorkspaceRoot('sp_default', 'th_legacy', base);
    assert.equal(target, join(base, 'sp_default', 'c', 'th_legacy'));
    assert.equal(existsSync(join(target, 'note.txt')), false);
    assert.equal(await readFile(join(legacy, 'note.txt'), 'utf8'), 'legacy thread workspace');
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
      assert.equal(managed.status, 403);
      const managedWrite = await fetch(`http://127.0.0.1:${port}/api/files/content`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'plugins/crm/readme.md',
          content: '# changed\n',
          baseSha256: 'irrelevant',
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
