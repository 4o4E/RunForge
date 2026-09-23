import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { resolveThreadWorkspaceRoot } from '../files/workspaceRoot.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { buildApp, listen, seedOwner } from './testHelpers.js';
import { store } from '../store/index.js';

test('Web file API rejects managed paths and user symlinks for reads and writes', async () => {
  const previousWorkspaceRoot = config.tools.workspaceRoot;
  const base = await mkdtemp(join(tmpdir(), 'runforge-file-api-path-security-'));
  config.tools.workspaceRoot = base;
  try {
    const tenantId = `tn_file_path_security_${randomUUID()}`;
    const owner = await seedOwner(tenantId, `owner+${tenantId}@file-path-security.test`, 'pw');
    const token = signTenantAccessToken({ id: owner.id, tenantId, role: 'owner' });
    const space = await store.getDefaultSpace(tenantId);
    assert.ok(space);
    const thread = await store.createThread({ tenantId, userId: owner.id }, 'path security', { spaceId: space.id });
    const root = resolveThreadWorkspaceRoot(space.id, thread.id, base);
    const outside = join(base, 'outside');
    await Promise.all([
      mkdir(join(root, '.agents'), { recursive: true }),
      mkdir(join(root, 'plugins'), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(root, '.agents', 'managed.md'), 'managed agent resource');
    await writeFile(join(root, 'plugins', 'managed.md'), 'managed plugin resource');
    await writeFile(join(root, 'normal.txt'), 'thread file');
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(join(outside, 'secret.txt'), join(root, 'private-link.txt'), 'file');

    const { port, close } = await listen(buildApp());
    const apiBase = `http://127.0.0.1:${port}/api/files`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
      for (const path of ['.agents/managed.md', 'plugins/managed.md', 'private-link.txt']) {
        const read = await fetch(`${apiBase}/content?path=${encodeURIComponent(path)}&threadId=${thread.id}`, { headers });
        assert.equal(read.status, 403, `GET ${path}`);
        const write = await fetch(`${apiBase}/content`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ path, content: 'changed', threadId: thread.id }),
        });
        assert.equal(write.status, 403, `PUT ${path}`);
      }
      assert.equal(await readFile(join(root, '.agents', 'managed.md'), 'utf8'), 'managed agent resource');
      assert.equal(await readFile(join(root, 'plugins', 'managed.md'), 'utf8'), 'managed plugin resource');
      assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'private');

      const listing = await fetch(`${apiBase}/list?path=.&threadId=${thread.id}`, { headers });
      assert.equal(listing.status, 200);
      const entries = ((await listing.json()) as { entries: Array<{ name: string }> }).entries;
      assert.deepEqual(entries.map((entry) => entry.name), ['normal.txt']);
    } finally {
      close();
    }
  } finally {
    config.tools.workspaceRoot = previousWorkspaceRoot;
    await rm(base, { recursive: true, force: true });
  }
});
