import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memoryStore.js';
import { runBootstrap } from './bootstrap.js';
import { verifyPassword } from './passwords.js';
import { hashOpaqueToken } from './tokens.js';

// 显式传参而不是 mutate 共享的 config.auth.* 全局状态：node:test 默认并发跑同文件内的
// 顶层 test()，不同用例互相 mutate 同一个全局对象会产生数据竞争(见 bootstrap.ts 的
// BootstrapOptions 设计)。

test('runBootstrap: fresh install with no legacy access token generates a login password', async () => {
  const store = new MemoryStore();
  const report = await runBootstrap(store, { legacyAccessToken: '', adminPassword: 'fresh-admin-pw', sysadminPassword: 'fresh-sysadmin-pw' });
  assert.equal(report.tenantCreated, true);
  assert.equal(report.ownerCreated, true);
  assert.equal(report.ownerSource, 'default-password');
  assert.equal(report.systemAdminCreated, true);

  const tenant = await store.findTenant('default');
  assert.ok(tenant);

  const users = await store.listUsersByTenant('default');
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'owner');
  assert.equal(users[0].email, 'admin@local');
  assert.ok(verifyPassword('fresh-admin-pw', users[0].password_hash));

  const admins = await store.listSystemAdmins();
  assert.equal(admins.length, 1);
  assert.ok(verifyPassword('fresh-sysadmin-pw', admins[0].password_hash));
});

test('runBootstrap: no password override falls back to the fixed default bootstrap password', async () => {
  const store = new MemoryStore();
  await runBootstrap(store, { legacyAccessToken: '' });

  const users = await store.listUsersByTenant('default');
  assert.equal(users.length, 1);
  assert.ok(verifyPassword('1234.RunForge.5678', users[0].password_hash));

  const admins = await store.listSystemAdmins();
  assert.equal(admins.length, 1);
  assert.ok(verifyPassword('1234.RunForge.5678', admins[0].password_hash));
});

test('runBootstrap: migration path registers the legacy access token as an API token for the new owner', async () => {
  const store = new MemoryStore();
  const report = await runBootstrap(store, { legacyAccessToken: 'legacy-static-token-value' });
  assert.equal(report.ownerCreated, true);
  assert.equal(report.ownerSource, 'migrated-access-token');

  const users = await store.listUsersByTenant('default');
  assert.equal(users.length, 1);
  const owner = users[0];
  assert.ok(verifyPassword('1234.RunForge.5678', owner.password_hash));

  const tokenRow = await store.findAuthTokenByHash(hashOpaqueToken('legacy-static-token-value'));
  assert.ok(tokenRow);
  assert.equal(tokenRow?.kind, 'api');
  assert.equal(tokenRow?.user_id, owner.id);
  assert.equal(tokenRow?.tenant_id, 'default');
  assert.equal(tokenRow?.revoked_at, null);
});

test('runBootstrap: idempotent — second run against the same store is a no-op', async () => {
  const store = new MemoryStore();
  await runBootstrap(store, { legacyAccessToken: 'legacy-static-token-value' });
  const usersAfterFirst = await store.listUsersByTenant('default');
  const adminsAfterFirst = await store.listSystemAdmins();

  const second = await runBootstrap(store, { legacyAccessToken: 'legacy-static-token-value' });
  assert.equal(second.tenantCreated, false);
  assert.equal(second.ownerCreated, false);
  assert.equal(second.systemAdminCreated, false);

  const usersAfterSecond = await store.listUsersByTenant('default');
  const adminsAfterSecond = await store.listSystemAdmins();
  assert.equal(usersAfterSecond.length, usersAfterFirst.length);
  assert.equal(adminsAfterSecond.length, adminsAfterFirst.length);
});
