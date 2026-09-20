import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memoryStore.js';
import type { Scope, ThreadRow } from '../store/types.js';
import { SpaceAccessService } from '../spaces/access.js';
import {
  ThreadWorkspaceAccessError,
  ThreadWorkspaceAccessService,
} from './threadWorkspace.js';
import { resolveThreadWorkspaceRoot } from './workspaceRoot.js';

async function fixture() {
  const store = new MemoryStore();
  const provisioned = await store.createTenantWithOwner({
    id: 'tn_thread_workspace',
    name: 'Thread Workspace',
    ownerEmail: 'owner@thread-workspace.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
  });
  const admin = await store.createUser({
    tenantId: provisioned.tenant.id,
    email: 'admin@thread-workspace.test',
    passwordHash: 'test-only',
    role: 'admin',
  });
  const member = await store.createUser({
    tenantId: provisioned.tenant.id,
    email: 'member@thread-workspace.test',
    passwordHash: 'test-only',
    role: 'member',
  });
  const hidden = await store.createUser({
    tenantId: provisioned.tenant.id,
    email: 'hidden@thread-workspace.test',
    passwordHash: 'test-only',
    role: 'member',
  });
  const spaces = new SpaceAccessService(store);
  const ownerIdentity = {
    scope: 'tenant' as const,
    tenantId: provisioned.tenant.id,
    userId: provisioned.owner.id,
    role: 'owner' as const,
  };
  return { store, spaces, provisioned, admin, member, hidden, ownerIdentity };
}

test('thread workspace: 所有空间都按 space/thread 隔离且文件入口必须绑定 thread', async () => {
  const ctx = await fixture();
  const base = '/srv/runforge/thread-workspace-test';
  const access = new ThreadWorkspaceAccessService(ctx.store, ctx.spaces, async () => ({ workspaceRoot: base }));
  const ownerScope = { tenantId: ctx.provisioned.tenant.id, userId: ctx.provisioned.owner.id };
  await assert.rejects(
    access.resolveForWeb(ctx.ownerIdentity, null, 'write'),
    (error: unknown) => error instanceof ThreadWorkspaceAccessError && error.code === 'THREAD_REQUIRED',
  );

  const defaultThread = await ctx.store.createThread(ownerScope, 'Default Thread', { spaceId: ctx.provisioned.defaultSpace.id });
  const defaultWorkspace = await access.resolveForWeb(ctx.ownerIdentity, defaultThread.id, 'write');
  assert.equal(defaultWorkspace.root, resolveThreadWorkspaceRoot(defaultThread.space_id, defaultThread.id, base));

  const space = await ctx.spaces.create(ctx.ownerIdentity, { mode: 'web', name: 'Project' });
  const thread = await ctx.store.createThread(ownerScope, 'Project Thread', { spaceId: space.id });
  const resolved = await access.resolveForWeb(ctx.ownerIdentity, thread.id, 'write');
  assert.equal(resolved.root, resolveThreadWorkspaceRoot(thread.space_id, thread.id, base));
  assert.notEqual(resolved.root, defaultWorkspace.root);

  const adminIdentity = {
    scope: 'tenant' as const,
    tenantId: ctx.provisioned.tenant.id,
    userId: ctx.admin.id,
    role: 'admin' as const,
  };
  await assert.rejects(
    access.resolveForWeb(adminIdentity, thread.id, 'read'),
    (error: unknown) => error instanceof ThreadWorkspaceAccessError && error.code === 'THREAD_NOT_FOUND',
  );
});

test('thread workspace: external thread 对可见用户只读且不冒充 execution user', async () => {
  const ctx = await fixture();
  const base = '/srv/runforge/external-thread-workspace-test';
  const externalSpace = await ctx.spaces.create(ctx.ownerIdentity, {
    mode: 'external',
    name: 'External',
    executionUserId: ctx.provisioned.owner.id,
    visibleUserIds: [ctx.member.id],
  });
  const externalThread: ThreadRow = {
    id: 'th_external_workspace',
    tenant_id: ctx.provisioned.tenant.id,
    user_id: ctx.provisioned.owner.id,
    space_id: externalSpace.id,
    source_type: 'external',
    source_caller_id: 'ec_test',
    source_ref: {},
    title: null,
    active_run_id: null,
    executing_run_id: null,
    pinned_at: null,
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const originalGetThread = ctx.store.getThread.bind(ctx.store);
  ctx.store.getThread = async (scope: Scope, id: string) => {
    if (id === externalThread.id && scope.tenantId === externalThread.tenant_id && scope.userId === externalThread.user_id) {
      return externalThread;
    }
    return originalGetThread(scope, id);
  };
  const originalGetThreadInSpaces = ctx.store.getThreadInSpaces.bind(ctx.store);
  ctx.store.getThreadInSpaces = async (tenantId: string, id: string, spaceIds: string[]) => {
    if (id === externalThread.id && tenantId === externalThread.tenant_id && spaceIds.includes(externalThread.space_id)) {
      return externalThread;
    }
    return originalGetThreadInSpaces(tenantId, id, spaceIds);
  };

  const access = new ThreadWorkspaceAccessService(ctx.store, ctx.spaces, async () => ({ workspaceRoot: base }));
  const memberIdentity = {
    scope: 'tenant' as const,
    tenantId: ctx.provisioned.tenant.id,
    userId: ctx.member.id,
    role: 'member' as const,
  };
  const visible = await access.resolveForWeb(memberIdentity, externalThread.id, 'read');
  assert.equal(visible.root, resolveThreadWorkspaceRoot(externalThread.space_id, externalThread.id, base));
  await assert.rejects(
    access.resolveForWeb(memberIdentity, externalThread.id, 'write'),
    (error: unknown) => error instanceof ThreadWorkspaceAccessError && error.code === 'SPACE_READ_ONLY',
  );

  const ownerExecution = await access.resolveForWeb(ctx.ownerIdentity, externalThread.id, 'read');
  assert.equal(ownerExecution.root, visible.root);
  await assert.rejects(
    access.resolveForWeb(ctx.ownerIdentity, externalThread.id, 'write'),
    (error: unknown) => error instanceof ThreadWorkspaceAccessError && error.code === 'SPACE_READ_ONLY',
  );

  const hiddenIdentity = {
    scope: 'tenant' as const,
    tenantId: ctx.provisioned.tenant.id,
    userId: ctx.hidden.id,
    role: 'member' as const,
  };
  await assert.rejects(
    access.resolveForWeb(hiddenIdentity, externalThread.id, 'read'),
    (error: unknown) => error instanceof ThreadWorkspaceAccessError && error.code === 'THREAD_NOT_FOUND',
  );
});
