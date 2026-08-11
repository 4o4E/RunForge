import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatHexRows, parseByteRange, previewTextLines } from './files.js';
import { signFileShare, verifyFileShare } from './auth.js';
import { config } from '../config.js';
import { isOfficeConvertiblePath, officePdfCacheKey } from '../files/officePreview.js';
import { resolveWorkspaceRoot } from '../files/workspaceRoot.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { buildApp, listen, seedOwner } from './testHelpers.js';

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
    const sig = signFileShare('artifacts/report.html', 'default', 'us_a', expires);

    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires), sig, 1000), true);
    assert.equal(verifyFileShare('artifacts/other.html', 'default', 'us_a', String(expires), sig, 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires + 1), sig, 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_a', String(expires), sig, 2001), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'other-tenant', 'us_a', String(expires), sig, 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', 'us_b', String(expires), sig, 1000), false);
  } finally {
    config.auth.accessToken = previousAccessToken;
    config.auth.shareSecret = previousShareSecret;
  }
});

test('workspace root is isolated by tenant and user', () => {
  const base = '/srv/runforge/workspace';
  assert.equal(resolveWorkspaceRoot({ tenantId: 'default', userId: 'us_a' }, base), '/srv/runforge/workspace/users/us_a/workspace');
  assert.equal(resolveWorkspaceRoot({ tenantId: 'default', userId: 'us_b' }, base), '/srv/runforge/workspace/users/us_b/workspace');
  assert.equal(resolveWorkspaceRoot({ tenantId: 'tn_a', userId: 'us_a' }, base), '/srv/runforge/workspace/tenants/tn_a/users/us_a/workspace');
  assert.notEqual(resolveWorkspaceRoot({ tenantId: 'tn_a', userId: 'us_a' }, base), resolveWorkspaceRoot({ tenantId: 'tn_a', userId: 'us_b' }, base));
});

test('office pdf preview only accepts office documents', () => {
  assert.equal(isOfficeConvertiblePath('demo.pptx'), true);
  assert.equal(isOfficeConvertiblePath('demo.xlsx'), true);
  assert.equal(isOfficeConvertiblePath('demo.docx'), true);
  assert.equal(isOfficeConvertiblePath('demo.pdf'), false);
});

test('office pdf cache key changes when source metadata changes', () => {
  const base = { tenantId: 'default', userId: 'us_a', remotePath: 'artifacts/demo.pptx', size: 10, mtimeMs: 100, converterUrl: 'http://converter:3000' };
  assert.equal(officePdfCacheKey(base), officePdfCacheKey(base));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, mtimeMs: 101 }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, cacheVersion: 'fonts-v2' }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, tenantId: 'other-tenant' }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, userId: 'us_b' }));
});

test('file content API saves text with version conflict protection', async () => {
  const previousWorkspaceRoot = config.tools.workspaceRoot;
  const base = await mkdtemp(join(tmpdir(), 'runforge-file-content-'));
  config.tools.workspaceRoot = base;
  try {
    const owner = await seedOwner('tn_file_content', 'owner@file-content.test', 'pw');
    const token = signTenantAccessToken({ id: owner.id, tenantId: 'tn_file_content', role: 'owner' });
    const root = resolveWorkspaceRoot({ tenantId: 'tn_file_content', userId: owner.id }, base);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/demo.ts'), 'export const value = 1;\n', 'utf8');

    const { port, close } = await listen(buildApp());
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const loaded = await fetch(`http://127.0.0.1:${port}/api/files/content?path=src%2Fdemo.ts`, { headers });
      assert.equal(loaded.status, 200);
      const body = (await loaded.json()) as { content: string; version: { sha256: string } };
      assert.equal(body.content, 'export const value = 1;\n');

      const saved = await fetch(`http://127.0.0.1:${port}/api/files/content`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'src/demo.ts', content: 'export const value = 2;\n', baseSha256: body.version.sha256 }),
      });
      assert.equal(saved.status, 200);
      assert.equal(await readFile(join(root, 'src/demo.ts'), 'utf8'), 'export const value = 2;\n');

      await writeFile(join(root, 'src/demo.ts'), 'export const value = 3;\n', 'utf8');
      const conflict = await fetch(`http://127.0.0.1:${port}/api/files/content`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'src/demo.ts', content: 'export const value = 4;\n', baseSha256: body.version.sha256 }),
      });
      assert.equal(conflict.status, 409);
      assert.equal(await readFile(join(root, 'src/demo.ts'), 'utf8'), 'export const value = 3;\n');
    } finally {
      close();
    }
  } finally {
    config.tools.workspaceRoot = previousWorkspaceRoot;
    await rm(base, { recursive: true, force: true });
  }
});
