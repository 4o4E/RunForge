import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { resolveThreadWorkspaceRoot } from '../files/workspaceRoot.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { buildApp, listen, seedOwner } from './testHelpers.js';
import { store } from '../store/index.js';
import { signFileShare } from './auth.js';
import { spaceAccess } from '../spaces/access.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { RunRow, ThreadRow } from '../store/types.js';
import type { ThreadInspection } from '@runforge/contracts';

test('Web file API rejects managed paths and user symlinks for reads and writes', async () => {
  const previousWorkspaceRoot = config.tools.workspaceRoot;
  const previousShareSecret = config.auth.shareSecret;
  config.auth.shareSecret = previousShareSecret || randomUUID();
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
      mkdir(join(root, 'nested', 'deep'), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(root, '.agents', 'managed.md'), 'managed agent resource');
    await writeFile(join(root, 'plugins', 'managed.md'), 'managed plugin resource');
    await writeFile(join(root, 'normal.txt'), 'thread file');
    await writeFile(join(outside, 'secret.txt'), 'private');
    await writeFile(join(root, 'nested', 'first.txt'), 'first');
    await writeFile(join(root, 'nested', 'deep', 'second.txt'), 'second');
    await symlink(outside, join(root, 'nested', 'outside-link'), 'dir');
    await symlink(root, join(root, 'nested', 'cycle'), 'dir');
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
      const body = (await listing.json()) as { totalSize: number; entries: Array<{ name: string; size: number; updatedAt: string }> };
      assert.deepEqual(body.entries.map((entry) => entry.name), ['nested', 'normal.txt']);
      assert.equal(body.entries[0]?.size, Buffer.byteLength('firstsecond'));
      assert.equal(body.totalSize, Buffer.byteLength('firstsecondthread file'));
      assert.ok(body.entries.every((entry) => Number.isFinite(Date.parse(entry.updatedAt))));

      const sourceText = '原始文本'.repeat(6000);
      await writeFile(join(root, 'long-line.txt'), sourceText);
      const source = await fetch(`${apiBase}/preview?path=long-line.txt&source=1&threadId=${thread.id}`, { headers });
      assert.equal(source.status, 200);
      assert.deepEqual((await source.json() as { lines: string[] }).lines, [sourceText]);
      for (const prefixSize of [4096, 256 * 1024]) {
        await writeFile(join(root, 'unknown-type'), Buffer.concat([Buffer.alloc(prefixSize, 0x41), Buffer.from([0x00, 0xff, 0x42])]));
        const binary = await fetch(`${apiBase}/preview?path=unknown-type&source=1&threadId=${thread.id}`, { headers });
        assert.equal(binary.status, 200);
        const binaryBody = await binary.json() as { binary?: true; lines: string[] };
        assert.equal(binaryBody.binary, true);
        assert.deepEqual(binaryBody.lines, []);
        assert.equal((await fetch(`${apiBase}/content?path=unknown-type&threadId=${thread.id}`, { headers })).status, 415);
      }

      const expires = Math.floor(Date.now() / 1000) + 60;
      const params = new URLSearchParams({
        path: 'normal.txt', tenant: tenantId, user: owner.id, spaceId: space.id, threadId: thread.id,
        expires: String(expires), sig: signFileShare('normal.txt', tenantId, owner.id, expires, space.id, thread.id),
      });
      const shared = await fetch(`${apiBase}/content?${params}`);
      assert.equal(shared.status, 200);
      const sharedBody = await shared.json() as { content: string; version: { mtimeMs: number } };
      assert.equal(sharedBody.content, 'thread file');
      params.set('path', 'nested/first.txt');
      assert.equal((await fetch(`${apiBase}/content?${params}`)).status, 403);
      params.set('path', '.');
      assert.equal((await fetch(`${apiBase}/list?${params}`)).status, 401);
      assert.equal((await fetch(`${apiBase}/content`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'normal.txt', content: 'changed', threadId: thread.id }),
      })).status, 401);
    } finally {
      close();
    }
  } finally {
    config.tools.workspaceRoot = previousWorkspaceRoot;
    config.auth.shareSecret = previousShareSecret;
    await rm(base, { recursive: true, force: true });
  }
});

test('thread inspection returns real earliest user messages and enforces Web and external visibility', async () => {
  assert.ok(store instanceof MemoryStore, '本用例验证真实内存模式；PG 的有界查询需真实数据库验证');
  const previousWorkspaceRoot = config.tools.workspaceRoot;
  const base = await mkdtemp(join(tmpdir(), 'runforge-thread-inspection-'));
  config.tools.workspaceRoot = base;
  try {
    const tenantId = `tn_inspection_${randomUUID()}`;
    const owner = await seedOwner(tenantId, `owner+${tenantId}@inspection.test`, 'pw');
    const member = await store.createUser({ tenantId, email: `member+${tenantId}@inspection.test`, passwordHash: 'test', role: 'member' });
    const hidden = await store.createUser({ tenantId, email: `hidden+${tenantId}@inspection.test`, passwordHash: 'test', role: 'member' });
    const identity = { scope: 'tenant' as const, tenantId, userId: owner.id, role: 'owner' as const };
    const admin = await store.createUser({ tenantId, email: `admin+${tenantId}@inspection.test`, passwordHash: 'test', role: 'admin' });
    const web = await spaceAccess.create(identity, { mode: 'web', name: 'Visible Web', visibleUserIds: [member.id] });
    const external = await spaceAccess.create(identity, {
      mode: 'external', name: 'External', executionUserId: owner.id, visibleUserIds: [member.id],
    });
    const ownerThread = await store.createThread({ tenantId, userId: owner.id }, 'Web', { spaceId: web.id });
    const ownThread = await store.createThread({ tenantId, userId: member.id }, 'Own Web', { spaceId: web.id });
    const scope = { tenantId, userId: owner.id };
    const run = await store.createRun(scope, ownerThread.id, 'run input must not replace persisted messages');
    // 外部 Repository 在 PG 内事务落库；此处与既有 spaces 测试一致，直接放入真实内存记录。
    const externalThread: ThreadRow = {
      ...ownerThread, id: `th_${randomUUID().replaceAll('-', '')}`, space_id: external.id,
      source_type: 'external', source_caller_id: 'ec_inspection', source_ref: { secret: 'not a user message' },
      active_run_id: `${run.id}ext`, executing_run_id: null,
    };
    // 内存模式没有外部写入口，测试夹具按生产 Repository 的落库结果补齐 thread/run 关系。
    const records = store as unknown as { threads: Map<string, ThreadRow>; runs: Map<string, RunRow> };
    records.threads.set(externalThread.id, externalThread);
    records.runs.set(`${run.id}ext`, { ...run, id: `${run.id}ext`, thread_id: externalThread.id });
    const inputs = ['😀'.repeat(300), 'second actual input', 'third actual input', 'fourth actual input'];
    for (const content of inputs) {
      await store.addMessage(scope, externalThread.id, `${run.id}ext`, null, { role: 'user', content });
    }
    const root = resolveThreadWorkspaceRoot(external.id, externalThread.id, base);
    const outside = join(base, 'shared');
    await mkdir(join(root, 'nested'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, 'nested', 'data.txt'), 'local-data');
    await writeFile(join(outside, 'large.bin'), Buffer.alloc(32 * 1024));
    await symlink(outside, join(root, 'shared-link'), 'dir');
    // 旧目录保持隔离，不应混入当前工作目录的用量。
    await mkdir(join(base, externalThread.id));
    await writeFile(join(base, externalThread.id, 'legacy.txt'), Buffer.alloc(64 * 1024));

    const { port, close } = await listen(buildApp());
    try {
      const inspect = (threadId: string, user: { id: string; role: 'owner' | 'member' }, spaceId?: string) => fetch(
        `http://127.0.0.1:${port}/api/threads/${threadId}/inspection${spaceId ? `?spaceId=${spaceId}` : ''}`,
        { headers: { Authorization: `Bearer ${signTenantAccessToken({ id: user.id, tenantId, role: user.role })}` } },
      );
      const response = await inspect(externalThread.id, { id: member.id, role: 'member' });
      assert.equal(response.status, 200);
      const body = await response.json() as ThreadInspection;
      assert.equal(body.threadId, externalThread.id);
      assert.deepEqual(body.userMessages.map((message) => message.content), ['😀'.repeat(240), inputs[1], inputs[2]]);
      assert.ok(body.userMessages.every((message) => Number.isFinite(Date.parse(message.createdAt))));
      assert.deepEqual(body.userMessages.map((message) => message.createdAt), body.userMessages.map((message) => message.createdAt).sort());
      assert.equal(body.storage.fileCount, 1);
      assert.equal(body.storage.symlinkCount, 1);
      assert.ok(body.storage.logicalBytes >= Buffer.byteLength('local-data') && body.storage.logicalBytes < 1024);
      assert.ok(body.storage.allocatedBytes >= Buffer.byteLength('local-data'));
      assert.equal((await inspect(externalThread.id, { id: hidden.id, role: 'member' })).status, 404);
      assert.equal((await inspect(externalThread.id, { id: member.id, role: 'member' }, web.id)).status, 404);
      assert.equal((await inspect(ownerThread.id, { id: member.id, role: 'member' })).status, 404);
      assert.equal((await inspect(ownerThread.id, { id: owner.id, role: 'owner' })).status, 200);
      const empty = await inspect(ownThread.id, { id: member.id, role: 'member' });
      assert.equal(empty.status, 200);
      const emptyBody = await empty.json() as ThreadInspection;
      assert.deepEqual(emptyBody.userMessages, []);
      assert.deepEqual(emptyBody.storage, { logicalBytes: 0, allocatedBytes: 0, fileCount: 0, symlinkCount: 0 });

      const threadUrl = `http://127.0.0.1:${port}/api/threads/${externalThread.id}`;
      const memberHeaders = { Authorization: `Bearer ${signTenantAccessToken({ id: member.id, tenantId, role: 'member' })}`, 'Content-Type': 'application/json' };
      const adminHeaders = { Authorization: `Bearer ${signTenantAccessToken({ id: admin.id, tenantId, role: 'admin' })}`, 'Content-Type': 'application/json' };
      assert.equal((await fetch(threadUrl, { method: 'PATCH', headers: memberHeaders, body: JSON.stringify({ pinned: true }) })).status, 403);
      assert.equal((await fetch(threadUrl, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ activeRunId: null }) })).status, 403);
      assert.equal((await fetch(`${threadUrl}/runs`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ input: 'must not execute' }) })).status, 404);
      const pinned = await fetch(threadUrl, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ pinned: true, title: '管理员管理外部对话' }) });
      assert.equal(pinned.status, 200);
      const pinnedThread = await pinned.json() as { title: string; pinned_at: string | null };
      assert.equal(pinnedThread.title, '管理员管理外部对话');
      assert.ok(pinnedThread.pinned_at);
      assert.equal((await fetch(threadUrl, { method: 'DELETE', headers: adminHeaders })).status, 409);
      assert.equal((await fetch(threadUrl, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ archived: true }) })).status, 200);
      assert.equal((await fetch(threadUrl, { method: 'DELETE', headers: memberHeaders })).status, 403);
      assert.equal((await fetch(threadUrl, { method: 'DELETE', headers: adminHeaders })).status, 204);
      assert.equal(await store.getThread(scope, externalThread.id), null);
      await assert.rejects(stat(root), { code: 'ENOENT' });
      assert.equal(await readFile(join(outside, 'large.bin')).then((buffer) => buffer.length), 32 * 1024);
    } finally {
      await close();
    }
  } finally {
    config.tools.workspaceRoot = previousWorkspaceRoot;
    await rm(base, { recursive: true, force: true });
  }
});
