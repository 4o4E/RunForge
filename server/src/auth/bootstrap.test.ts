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

  assert.match(report.tenantId, /^tn_[0-9A-Za-z]+$/);
  const tenant = await store.findTenant(report.tenantId);
  assert.ok(tenant);
  assert.equal(tenant.is_bootstrap, true);
  const defaultSpace = await store.getDefaultSpace(report.tenantId);
  assert.ok(defaultSpace);
  assert.equal(tenant.default_space_id, defaultSpace.id);
  assert.match(defaultSpace.id, /^sp_[0-9A-Za-z]+$/);
  assert.equal(defaultSpace.mode, 'web');
  assert.equal(defaultSpace.name, 'Default');

  const users = await store.listUsersByTenant(report.tenantId);
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'owner');
  assert.equal(users[0].is_bootstrap, true);
  assert.equal(users[0].email, 'admin@local');
  assert.ok(verifyPassword('fresh-admin-pw', users[0].password_hash));
  assert.equal(defaultSpace.created_by_user_id, users[0].id);

  const admins = await store.listSystemAdmins();
  assert.equal(admins.length, 1);
  assert.equal(admins[0].is_bootstrap, true);
  assert.ok(verifyPassword('fresh-sysadmin-pw', admins[0].password_hash));
});

test('runBootstrap: no password override falls back to the fixed default bootstrap password', async () => {
  const store = new MemoryStore();
  const report = await runBootstrap(store, { legacyAccessToken: '' });

  const users = await store.listUsersByTenant(report.tenantId);
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

  const users = await store.listUsersByTenant(report.tenantId);
  assert.equal(users.length, 1);
  const owner = users[0];
  assert.ok(verifyPassword('1234.RunForge.5678', owner.password_hash));

  const tokenRow = await store.findAuthTokenByHash(hashOpaqueToken('legacy-static-token-value'));
  assert.ok(tokenRow);
  assert.equal(tokenRow?.kind, 'api');
  assert.equal(tokenRow?.user_id, owner.id);
  assert.equal(tokenRow?.tenant_id, report.tenantId);
  assert.equal(tokenRow?.revoked_at, null);
});

test('runBootstrap: idempotent — second run against the same store is a no-op', async () => {
  const store = new MemoryStore();
  const first = await runBootstrap(store, { legacyAccessToken: 'legacy-static-token-value' });
  const usersAfterFirst = await store.listUsersByTenant(first.tenantId);
  const adminsAfterFirst = await store.listSystemAdmins();

  const second = await runBootstrap(store, { legacyAccessToken: 'legacy-static-token-value' });
  assert.equal(second.tenantCreated, false);
  assert.equal(second.ownerCreated, false);
  assert.equal(second.systemAdminCreated, false);

  assert.equal(second.tenantId, first.tenantId);
  const usersAfterSecond = await store.listUsersByTenant(first.tenantId);
  const adminsAfterSecond = await store.listSystemAdmins();
  assert.equal(usersAfterSecond.length, usersAfterFirst.length);
  assert.equal(adminsAfterSecond.length, adminsAfterFirst.length);
});

test('runBootstrap: 已停用的 owner 仍满足租户 owner 存在性约束', async () => {
  const store = new MemoryStore();
  const first = await runBootstrap(store, {
    legacyAccessToken: '',
    adminPassword: 'admin-password',
    sysadminPassword: 'sysadmin-password',
  });
  const [owner] = await store.listUsersByTenant(first.tenantId);
  await store.updateUser(owner.id, { status: 'disabled' });

  const second = await runBootstrap(store, {
    legacyAccessToken: '',
    adminPassword: 'admin-password',
    sysadminPassword: 'sysadmin-password',
  });

  assert.equal(second.ownerCreated, false);
  assert.equal((await store.listUsersByTenant(first.tenantId)).length, 1);
});

test('runBootstrap: 旧 default 主键迁移为雪花 ID，并更新关联数据', async () => {
  const store = new MemoryStore();
  const provisioned = await store.createTenantWithOwner({
    id: 'default',
    name: 'Default',
    ownerEmail: 'owner@legacy.test',
    ownerPasswordHash: 'legacy-password-hash',
    settingsTemplate: [],
  });
  const oldScope = { tenantId: 'default', userId: provisioned.owner.id };
  const thread = await store.createThread(oldScope, 'Legacy thread', { spaceId: provisioned.defaultSpace.id });
  await store.createAuthToken({
    tenantId: 'default',
    userId: provisioned.owner.id,
    kind: 'api',
    tokenHash: hashOpaqueToken('legacy-owner-token'),
    label: 'legacy',
  });

  const report = await runBootstrap(store, {
    legacyAccessToken: '',
    adminPassword: 'unused',
    sysadminPassword: 'sysadmin-password',
    migrateWorkspace: false,
  });

  assert.equal(report.tenantIdMigrated, true);
  assert.match(report.tenantId, /^tn_[0-9A-Za-z]+$/);
  assert.equal(await store.findTenant('default'), null);
  assert.equal((await store.findTenant(report.tenantId))?.name, 'Default');
  assert.equal((await store.findTenant(report.tenantId))?.is_bootstrap, true);
  assert.equal((await store.findUserById(provisioned.owner.id))?.tenant_id, report.tenantId);
  assert.equal((await store.findUserById(provisioned.owner.id))?.is_bootstrap, true);
  assert.equal((await store.findSpace(report.tenantId, provisioned.defaultSpace.id))?.tenant_id, report.tenantId);
  assert.equal((await store.getThread({ tenantId: report.tenantId, userId: provisioned.owner.id }, thread.id))?.tenant_id, report.tenantId);
  assert.equal((await store.findAuthTokenByHash(hashOpaqueToken('legacy-owner-token')))?.tenant_id, report.tenantId);
});
