import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memoryStore.js';
import { SpaceAccessError, SpaceAccessService, parseUpdateSpaceInput } from './access.js';

async function fixture() {
  const store = new MemoryStore();
  const provisioned = await store.createTenantWithOwner({
    id: 'tn_space_test',
    name: 'Space Test',
    ownerEmail: 'owner@space.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
  });
  const admin = await store.createUser({
    tenantId: provisioned.tenant.id,
    email: 'admin@space.test',
    passwordHash: 'test-only',
    role: 'admin',
  });
  const member = await store.createUser({
    tenantId: provisioned.tenant.id,
    email: 'member@space.test',
    passwordHash: 'test-only',
    role: 'member',
  });
  const hiddenMember = await store.createUser({
    tenantId: provisioned.tenant.id,
    email: 'hidden@space.test',
    passwordHash: 'test-only',
    role: 'member',
  });
  const service = new SpaceAccessService(store);
  return {
    store,
    service,
    provisioned,
    admin,
    member,
    hiddenMember,
    ownerIdentity: {
      scope: 'tenant' as const,
      tenantId: provisioned.tenant.id,
      userId: provisioned.owner.id,
      role: 'owner' as const,
    },
    adminIdentity: {
      scope: 'tenant' as const,
      tenantId: provisioned.tenant.id,
      userId: admin.id,
      role: 'admin' as const,
    },
    memberIdentity: {
      scope: 'tenant' as const,
      tenantId: provisioned.tenant.id,
      userId: member.id,
      role: 'member' as const,
    },
    hiddenIdentity: {
      scope: 'tenant' as const,
      tenantId: provisioned.tenant.id,
      userId: hiddenMember.id,
      role: 'member' as const,
    },
  };
}

test('SpaceAccessService: 管理员始终可见，member 严格按名单可见', async () => {
  const ctx = await fixture();
  const space = await ctx.service.create(ctx.ownerIdentity, {
    mode: 'web',
    name: 'Member Space',
    visibleUserIds: [ctx.member.id],
  });

  assert.deepEqual((await ctx.service.list(ctx.ownerIdentity)).map((item) => item.id), [
    ctx.provisioned.defaultSpace.id,
    space.id,
  ]);
  assert.deepEqual((await ctx.service.list(ctx.adminIdentity)).map((item) => item.id), [
    ctx.provisioned.defaultSpace.id,
    space.id,
  ]);
  assert.equal((await ctx.service.update(ctx.adminIdentity, space.id, { name: 'Admin Updated' })).name, 'Admin Updated');
  assert.deepEqual((await ctx.service.list(ctx.memberIdentity)).map((item) => item.id), [space.id]);
  assert.deepEqual(await ctx.service.list(ctx.hiddenIdentity), []);
  await assert.rejects(
    ctx.service.get(ctx.hiddenIdentity, space.id),
    (error: unknown) => error instanceof SpaceAccessError && error.status === 404,
  );
  await assert.rejects(
    ctx.service.create(ctx.memberIdentity, { mode: 'web', name: 'Forbidden' }),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'SPACE_MANAGE_FORBIDDEN',
  );

  await ctx.store.updateUserStatus(ctx.member.id, 'disabled');
  await assert.rejects(
    ctx.service.list(ctx.memberIdentity),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'SPACE_ACTOR_DISABLED',
  );
});

test('SpaceAccessService: external space 只接受本 tenant 的 active execution user', async () => {
  const ctx = await fixture();
  await assert.rejects(
    ctx.service.create(ctx.ownerIdentity, { mode: 'external', name: 'Missing User' }),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'SPACE_EXECUTION_USER_REQUIRED',
  );

  const other = await ctx.store.createTenantWithOwner({
    id: 'tn_space_other',
    name: 'Other',
    ownerEmail: 'owner@other.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
  });
  await assert.rejects(
    ctx.service.create(ctx.ownerIdentity, {
      mode: 'external',
      name: 'Cross Tenant',
      executionUserId: other.owner.id,
    }),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'SPACE_EXECUTION_USER_INVALID',
  );

  const external = await ctx.service.create(ctx.ownerIdentity, {
    mode: 'external',
    name: 'External',
    executionUserId: ctx.member.id,
    visibleUserIds: [ctx.hiddenMember.id],
    config: { systemPrompt: 'v1' },
  });
  assert.equal(external.executionUserId, ctx.member.id);
  assert.equal(external.configVersion, 1);

  const updated = await ctx.service.update(ctx.ownerIdentity, external.id, {
    executionUserId: ctx.hiddenMember.id,
    config: { systemPrompt: 'v2' },
  });
  assert.equal(updated.executionUserId, ctx.hiddenMember.id);
  assert.equal(updated.configVersion, 2);
  assert.deepEqual(updated.visibleUserIds, [ctx.hiddenMember.id]);
});

test('SpaceAccessService: default 不可重命名删除，普通空间软删除和恢复保留名单', async () => {
  const ctx = await fixture();
  await assert.rejects(
    ctx.service.update(ctx.ownerIdentity, ctx.provisioned.defaultSpace.id, { name: 'Renamed' }),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'DEFAULT_SPACE_IMMUTABLE',
  );
  await assert.rejects(
    ctx.service.delete(ctx.ownerIdentity, ctx.provisioned.defaultSpace.id),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'DEFAULT_SPACE_IMMUTABLE',
  );

  const configuredDefault = await ctx.service.update(ctx.ownerIdentity, ctx.provisioned.defaultSpace.id, {
    config: { systemPrompt: 'updated' },
  });
  assert.equal(configuredDefault.configVersion, 2);

  const space = await ctx.service.create(ctx.ownerIdentity, {
    mode: 'web',
    name: 'Recoverable',
    visibleUserIds: [ctx.member.id],
  });
  const deleted = await ctx.service.delete(ctx.ownerIdentity, space.id);
  assert.ok(deleted.deletedAt);
  assert.deepEqual(await ctx.service.list(ctx.memberIdentity), []);
  assert.equal((await ctx.service.list(ctx.ownerIdentity, true)).some((item) => item.id === space.id), true);

  const restored = await ctx.service.restore(ctx.ownerIdentity, space.id);
  assert.equal(restored.deletedAt, null);
  assert.deepEqual(restored.visibleUserIds, [ctx.member.id]);
  assert.deepEqual((await ctx.service.list(ctx.memberIdentity)).map((item) => item.id), [space.id]);
});

test('SpaceAccessService: Web 写入只允许可见的未删除 web space', async () => {
  const ctx = await fixture();
  const web = await ctx.service.create(ctx.ownerIdentity, {
    mode: 'web',
    name: 'Writable',
    visibleUserIds: [ctx.member.id],
  });
  const external = await ctx.service.create(ctx.ownerIdentity, {
    mode: 'external',
    name: 'Read Only',
    executionUserId: ctx.member.id,
    visibleUserIds: [ctx.member.id],
  });

  assert.equal((await ctx.service.requireWritableWebSpace(ctx.memberIdentity, web.id)).id, web.id);
  await assert.rejects(
    ctx.service.requireWritableWebSpace(ctx.ownerIdentity, external.id),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'SPACE_READ_ONLY',
  );
  await ctx.service.delete(ctx.ownerIdentity, web.id);
  await assert.rejects(
    ctx.service.requireWritableWebSpace(ctx.memberIdentity, web.id),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'SPACE_DELETED',
  );
});

test('Store: 即使调用方漏掉 SpaceAccessService，创建 thread/run 仍会复核名单', async () => {
  const ctx = await fixture();
  const web = await ctx.service.create(ctx.ownerIdentity, {
    mode: 'web',
    name: 'Store Guard',
    visibleUserIds: [ctx.member.id],
  });
  const memberScope = { tenantId: ctx.provisioned.tenant.id, userId: ctx.member.id };
  const thread = await ctx.store.createThread(memberScope, 'allowed', { spaceId: web.id });
  await ctx.service.update(ctx.ownerIdentity, web.id, { visibleUserIds: [] });
  await assert.rejects(ctx.store.createThread(memberScope, 'hidden', { spaceId: web.id }), /不可写/);
  await assert.rejects(ctx.store.createRun(memberScope, thread.id, 'hidden run'), /不可写/);
});

test('space input: mode 不能通过 PATCH 修改', () => {
  assert.throws(
    () => parseUpdateSpaceInput({ mode: 'external' }),
    (error: unknown) => error instanceof SpaceAccessError && error.code === 'SPACE_MODE_IMMUTABLE',
  );
});
