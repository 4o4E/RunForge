import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { signSystemAccessToken, signTenantAccessToken } from '../auth/jwt.js';
import { store } from '../store/index.js';
import type { SpaceSummary } from '@runforge/contracts';
import { buildApp, listen, seedOwner, seedSystemAdmin } from './testHelpers.js';

test.before(() => {
  config.auth.jwtSecret = config.auth.jwtSecret || 'test-jwt-secret';
});

function bearer(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

test('space API: 管理权限、可见名单、execution user 和软删除语义完整生效', async () => {
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
    const createdWebResponse = await fetch(`${base}/spaces`, {
      method: 'POST',
      headers: bearer(ownerToken),
      body: JSON.stringify({ mode: 'web', name: 'Team Web', visibleUserIds: [member.id], config: { systemPrompt: 'v1' } }),
    });
    assert.equal(createdWebResponse.status, 201);
    const webSpace = (await createdWebResponse.json()) as SpaceSummary;
    assert.match(webSpace.id, /^sp_[0-9A-Za-z]+$/);
    assert.deepEqual(webSpace.visibleUserIds, [member.id]);
    assert.equal(webSpace.config.schemaVersion, 1);
    assert.equal(webSpace.config.systemPrompt, 'v1');

    const externalResponse = await fetch(`${base}/spaces`, {
      method: 'POST',
      headers: bearer(ownerToken),
      body: JSON.stringify({
        mode: 'external',
        name: 'External Read Only',
        executionUserId: member.id,
        visibleUserIds: [member.id],
      }),
    });
    assert.equal(externalResponse.status, 201);
    const externalSpace = (await externalResponse.json()) as SpaceSummary;

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
    assert.deepEqual(await hiddenThreads.json(), []);
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
    assert.equal(renameDefault.status, 409);
    const deleteDefault = await fetch(`${base}/spaces/${defaultSpace.id}`, {
      method: 'DELETE',
      headers: bearer(ownerToken),
    });
    assert.equal(deleteDefault.status, 409);

    const deleted = await fetch(`${base}/spaces/${webSpace.id}`, { method: 'DELETE', headers: bearer(ownerToken) });
    assert.equal(deleted.status, 200);
    assert.ok(((await deleted.json()) as SpaceSummary).deletedAt);
    const afterDelete = await fetch(`${base}/spaces`, { headers: bearer(memberToken) });
    assert.deepEqual(
      ((await afterDelete.json()) as { spaces: SpaceSummary[] }).spaces.map((space) => space.id),
      [externalSpace.id],
    );
    const restored = await fetch(`${base}/spaces/${webSpace.id}/restore`, { method: 'POST', headers: bearer(ownerToken) });
    assert.equal(restored.status, 200);
    assert.deepEqual(((await restored.json()) as SpaceSummary).visibleUserIds, [member.id]);
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
  } finally {
    close();
  }
});
