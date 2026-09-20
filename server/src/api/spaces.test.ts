import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { signSystemAccessToken, signTenantAccessToken } from '../auth/jwt.js';
import { store } from '../store/index.js';
import type {
  PromptPlaceholdersView,
  SpaceDebugView,
  SpaceOptions,
  SpaceSummary,
} from '@runforge/contracts';
import { buildApp, listen, seedOwner, seedSystemAdmin } from './testHelpers.js';
import { newThreadId } from '../id.js';
import type { ThreadRow } from '../store/types.js';

test.before(() => {
  config.auth.jwtSecret = config.auth.jwtSecret || 'test-jwt-secret';
});

function bearer(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

test('space API: 管理权限、可见名单、execution user 和永久删除语义完整生效', async () => {
  const tenantId = 'tn_spaces_api';
  const owner = await seedOwner(tenantId, 'owner@spaces-api.test', 'pw');
  const member = await store.createUser({ tenantId, email: 'member@spaces-api.test', passwordHash: 'test', role: 'member' });
  const hidden = await store.createUser({ tenantId, email: 'hidden@spaces-api.test', passwordHash: 'test', role: 'member' });
  const otherOwner = await seedOwner('tn_spaces_other', 'owner@spaces-other.test', 'pw');
  const ownerToken = signTenantAccessToken({ id: owner.id, tenantId, role: 'owner' });
  const memberToken = signTenantAccessToken({ id: member.id, tenantId, role: 'member' });
  const hiddenToken = signTenantAccessToken({ id: hidden.id, tenantId, role: 'member' });
  const staleElevatedToken = signTenantAccessToken({ id: member.id, tenantId, role: 'owner' });
  const { port, close } = await listen(buildApp());
  const base = `http://127.0.0.1:${port}/api`;
  try {
    const optionsResponse = await fetch(`${base}/spaces/options`, { headers: bearer(ownerToken) });
    assert.equal(optionsResponse.status, 200);
    const options = (await optionsResponse.json()) as SpaceOptions;
    assert.ok(options.defaultModelRef);
    assert.ok(options.models.some((model) => model.ref === options.defaultModelRef));
    assert.ok(options.tools.includes('file_read'));

    const createdWebResponse = await fetch(`${base}/spaces`, {
      method: 'POST',
      headers: bearer(ownerToken),
      body: JSON.stringify({ mode: 'web', name: 'Team Web', visibleUserIds: [member.id], config: { systemPrompt: 'v1' } }),
    });
    assert.equal(createdWebResponse.status, 201);
    const webSpace = (await createdWebResponse.json()) as SpaceSummary;
    assert.match(webSpace.id, /^sp_[0-9A-Za-z]+$/);
    assert.deepEqual(webSpace.visibleUserIds, [member.id]);
    assert.equal(webSpace.config.schemaVersion, 3);
    assert.match(webSpace.config.promptTemplate, /v1/);

    const ownerDebugResponse = await fetch(`${base}/spaces/${webSpace.id}/debug`, { headers: bearer(ownerToken) });
    assert.equal(ownerDebugResponse.status, 200);
    const ownerDebug = (await ownerDebugResponse.json()) as SpaceDebugView;
    assert.equal(ownerDebug.configVersion, webSpace.configVersion);
    assert.match(ownerDebug.promptTemplate, /v1/);
    assert.ok(ownerDebug.tools.some((tool) => (
      tool.name === 'file_read'
      && (tool.parameters.properties as Record<string, unknown>).path !== undefined
    )));
    assert.ok(ownerDebug.skills.some((skill) => skill.id.startsWith('builtin:') && skill.content.length > 0));

    const ownerPlaceholdersResponse = await fetch(
      `${base}/spaces/${webSpace.id}/prompt-placeholders`,
      { headers: bearer(ownerToken) },
    );
    assert.equal(ownerPlaceholdersResponse.status, 200);
    const ownerPlaceholders = (await ownerPlaceholdersResponse.json()) as PromptPlaceholdersView;
    assert.equal(ownerPlaceholders.placeholders.length, 12);
    assert.ok(ownerPlaceholders.placeholders.some((item) => (
      item.key === 'skills.catalog'
      && item.token === '{{skills.catalog}}'
      && item.content.includes('Available skills')
    )));

    const memberDebugResponse = await fetch(`${base}/spaces/${webSpace.id}/debug`, { headers: bearer(memberToken) });
    assert.equal(memberDebugResponse.status, 403);
    assert.equal(((await memberDebugResponse.json()) as { code: string }).code, 'SPACE_MANAGE_FORBIDDEN');
    const memberPlaceholdersResponse = await fetch(
      `${base}/spaces/${webSpace.id}/prompt-placeholders`,
      { headers: bearer(memberToken) },
    );
    assert.equal(memberPlaceholdersResponse.status, 403);

    const unknownMcpSchema = await fetch(`${base}/spaces/${webSpace.id}/debug/mcp/missing`, {
      headers: bearer(ownerToken),
    });
    assert.equal(unknownMcpSchema.status, 409);
    const memberMcpSchema = await fetch(`${base}/spaces/${webSpace.id}/debug/mcp/missing`, {
      headers: bearer(memberToken),
    });
    assert.equal(memberMcpSchema.status, 403);

    const externalResponse = await fetch(`${base}/spaces`, {
      method: 'POST',
      headers: bearer(ownerToken),
      body: JSON.stringify({
        mode: 'external',
        name: 'External Read Only',
        executionUserId: owner.id,
        visibleUserIds: [member.id],
      }),
    });
    assert.equal(externalResponse.status, 201);
    const externalSpace = (await externalResponse.json()) as SpaceSummary;
    const externalStoredThread: ThreadRow = {
      id: newThreadId(),
      tenant_id: tenantId,
      user_id: owner.id,
      space_id: externalSpace.id,
      source_type: 'external',
      source_caller_id: 'ec_spaces_api',
      source_ref: { externalThreadRef: 'trusted-app-thread-1' },
      title: 'External Task',
      active_run_id: null,
      executing_run_id: null,
      pinned_at: null,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // 外部 Repository 在生产中直接事务写 Prisma；MemoryStore 测试没有对应写入口，
    // 这里只注入已落库结果，验证 Web 查看边界而不是重复测试外部创建协议。
    (store as unknown as { threads: Map<string, ThreadRow> }).threads.set(externalStoredThread.id, externalStoredThread);

    const crossTenantExecution = await fetch(`${base}/spaces`, {
      method: 'POST',
      headers: bearer(ownerToken),
      body: JSON.stringify({ mode: 'external', name: 'Invalid', executionUserId: otherOwner.id }),
    });
    assert.equal(crossTenantExecution.status, 400);
    assert.equal(((await crossTenantExecution.json()) as { code: string }).code, 'SPACE_EXECUTION_USER_INVALID');

    const memberList = await fetch(`${base}/spaces`, { headers: bearer(memberToken) });
    assert.equal(memberList.status, 200);
    assert.deepEqual(
      ((await memberList.json()) as { spaces: SpaceSummary[] }).spaces.map((space) => space.id).sort(),
      [externalSpace.id, webSpace.id].sort(),
    );
    const hiddenList = await fetch(`${base}/spaces`, { headers: bearer(hiddenToken) });
    assert.deepEqual(((await hiddenList.json()) as { spaces: SpaceSummary[] }).spaces, []);

    const externalThreads = await fetch(`${base}/threads?spaceId=${externalSpace.id}`, { headers: bearer(memberToken) });
    assert.equal(externalThreads.status, 200);
    assert.deepEqual(
      ((await externalThreads.json()) as Array<{ id: string }>).map((thread) => thread.id),
      [externalStoredThread.id],
    );
    const externalDetail = await fetch(
      `${base}/threads/${externalStoredThread.id}?spaceId=${externalSpace.id}`,
      { headers: bearer(memberToken) },
    );
    assert.equal(externalDetail.status, 200);
    const externalDetailBody = (await externalDetail.json()) as {
      readOnly: boolean;
      space: SpaceSummary;
      thread: { source_ref: Record<string, unknown> };
    };
    assert.equal(externalDetailBody.readOnly, true);
    assert.equal(externalDetailBody.space.id, externalSpace.id);
    assert.equal(externalDetailBody.thread.source_ref.externalThreadRef, 'trusted-app-thread-1');
    const mismatchedSpace = await fetch(
      `${base}/threads/${externalStoredThread.id}?spaceId=${webSpace.id}`,
      { headers: bearer(memberToken) },
    );
    assert.equal(mismatchedSpace.status, 404);
    const hiddenExternalDetail = await fetch(
      `${base}/threads/${externalStoredThread.id}?spaceId=${externalSpace.id}`,
      { headers: bearer(hiddenToken) },
    );
    assert.equal(hiddenExternalDetail.status, 404);
    const ownerCannotMutateExternal = await fetch(`${base}/threads/${externalStoredThread.id}`, {
      method: 'PATCH',
      headers: bearer(ownerToken),
      body: JSON.stringify({ title: 'forbidden' }),
    });
    assert.equal(ownerCannotMutateExternal.status, 403);

    const staleRoleCreate = await fetch(`${base}/spaces`, {
      method: 'POST',
      headers: bearer(staleElevatedToken),
      body: JSON.stringify({ mode: 'web', name: 'Forbidden' }),
    });
    assert.equal(staleRoleCreate.status, 403);

    const memberThread = await fetch(`${base}/threads`, {
      method: 'POST',
      headers: bearer(memberToken),
      body: JSON.stringify({ title: 'Allowed', spaceId: webSpace.id }),
    });
    assert.equal(memberThread.status, 201);
    const memberThreadBody = (await memberThread.json()) as { id: string; space_id: string };
    assert.equal(memberThreadBody.space_id, webSpace.id);

    const hiddenThread = await fetch(`${base}/threads`, {
      method: 'POST',
      headers: bearer(hiddenToken),
      body: JSON.stringify({ title: 'Hidden', spaceId: webSpace.id }),
    });
    assert.equal(hiddenThread.status, 404);

    const externalThread = await fetch(`${base}/threads`, {
      method: 'POST',
      headers: bearer(ownerToken),
      body: JSON.stringify({ title: 'Read Only', spaceId: externalSpace.id }),
    });
    assert.equal(externalThread.status, 403);
    assert.equal(((await externalThread.json()) as { code: string }).code, 'SPACE_READ_ONLY');

    const removeVisibility = await fetch(`${base}/spaces/${webSpace.id}`, {
      method: 'PATCH',
      headers: bearer(ownerToken),
      body: JSON.stringify({ visibleUserIds: [] }),
    });
    assert.equal(removeVisibility.status, 200);
    const hiddenThreads = await fetch(`${base}/threads`, { headers: bearer(memberToken) });
    assert.deepEqual(
      ((await hiddenThreads.json()) as Array<{ id: string }>).map((thread) => thread.id),
      [externalStoredThread.id],
    );
    const hiddenThreadDetail = await fetch(`${base}/threads/${memberThreadBody.id}`, { headers: bearer(memberToken) });
    assert.equal(hiddenThreadDetail.status, 404);
    const restoreVisibility = await fetch(`${base}/spaces/${webSpace.id}`, {
      method: 'PATCH',
      headers: bearer(ownerToken),
      body: JSON.stringify({ visibleUserIds: [member.id] }),
    });
    assert.equal(restoreVisibility.status, 200);

    const ownerSpaces = await fetch(`${base}/spaces`, { headers: bearer(ownerToken) });
    const defaultSpace = ((await ownerSpaces.json()) as { spaces: SpaceSummary[] }).spaces.find((space) => space.isDefault);
    assert.ok(defaultSpace);
    const renameDefault = await fetch(`${base}/spaces/${defaultSpace.id}`, {
      method: 'PATCH',
      headers: bearer(ownerToken),
      body: JSON.stringify({ name: 'Renamed' }),
    });
    assert.equal(renameDefault.status, 200);
    assert.equal(((await renameDefault.json()) as SpaceSummary).name, 'Renamed');
    const deleteDefault = await fetch(`${base}/spaces/${defaultSpace.id}`, {
      method: 'DELETE',
      headers: bearer(ownerToken),
    });
    assert.equal(deleteDefault.status, 409);

    const deleted = await fetch(`${base}/spaces/${webSpace.id}`, { method: 'DELETE', headers: bearer(ownerToken) });
    assert.equal(deleted.status, 204);
    const afterDelete = await fetch(`${base}/spaces`, { headers: bearer(memberToken) });
    assert.deepEqual(
      ((await afterDelete.json()) as { spaces: SpaceSummary[] }).spaces.map((space) => space.id),
      [externalSpace.id],
    );
    const deletedDetail = await fetch(`${base}/spaces/${webSpace.id}`, { headers: bearer(ownerToken) });
    assert.equal(deletedDetail.status, 404);
  } finally {
    close();
  }
});

test('system space API: system admin 可管理指定 tenant，但 createdByUserId 为空', async () => {
  const tenantId = 'tn_spaces_system';
  const owner = await seedOwner(tenantId, 'owner@spaces-system.test', 'pw');
  const systemAdmin = await seedSystemAdmin('sysadmin@spaces-system.test', 'pw');
  const token = signSystemAccessToken({ id: systemAdmin.id });
  const { port, close } = await listen(buildApp());
  try {
    const optionsResponse = await fetch(
      `http://127.0.0.1:${port}/api/system/tenants/${tenantId}/spaces/options`,
      { headers: bearer(token) },
    );
    assert.equal(optionsResponse.status, 200);
    assert.ok(((await optionsResponse.json()) as SpaceOptions).models.length > 0);

    const response = await fetch(`http://127.0.0.1:${port}/api/system/tenants/${tenantId}/spaces`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ mode: 'external', name: 'System Managed', executionUserId: owner.id }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as SpaceSummary;
    assert.equal(body.tenantId, tenantId);
    assert.equal(body.createdByUserId, null);
    assert.equal(body.executionUserId, owner.id);

    const placeholdersResponse = await fetch(
      `http://127.0.0.1:${port}/api/system/tenants/${tenantId}/spaces/${body.id}/prompt-placeholders`,
      { headers: bearer(token) },
    );
    assert.equal(placeholdersResponse.status, 200);
    assert.equal(((await placeholdersResponse.json()) as PromptPlaceholdersView).placeholders.length, 12);
  } finally {
    close();
  }
});
