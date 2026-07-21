import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { store } from '../store/index.js';
import { hashPassword } from '../auth/passwords.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { buildApp, listen, seedOwner } from './testHelpers.js';

test.before(() => {
  config.auth.jwtSecret = config.auth.jwtSecret || 'test-jwt-secret';
});

test('GET /api/tenants/me: 返回当前登录用户自己的信息', async () => {
  const owner = await seedOwner('tn_me', 'owner@me.test', 'pw');
  const jwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_me', role: 'owner' });
  const { port, close } = await listen(buildApp());
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tenants/me`, { headers: { Authorization: `Bearer ${jwt}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; email: string; role: string };
    assert.equal(body.id, owner.id);
    assert.equal(body.email, 'owner@me.test');
    assert.equal(body.role, 'owner');
  } finally {
    close();
  }
});

test('PATCH /api/tenants/:id/users/:userId: owner 能改 member 角色，admin 不能自我提权或动别的 admin/owner', async () => {
  const owner = await seedOwner('tn_patch_users', 'owner@patch.test', 'pw');
  const admin = await store.createUser({ tenantId: 'tn_patch_users', email: 'admin@patch.test', passwordHash: hashPassword('pw'), role: 'admin' });
  const member = await store.createUser({ tenantId: 'tn_patch_users', email: 'member@patch.test', passwordHash: hashPassword('pw'), role: 'member' });
  const ownerJwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_patch_users', role: 'owner' });
  const adminJwt = signTenantAccessToken({ id: admin.id, tenantId: 'tn_patch_users', role: 'admin' });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api/tenants/tn_patch_users/users`;

    // owner 把 member 提升到 admin：应成功。
    const ownerPromotes = await fetch(`${base}/${member.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(ownerPromotes.status, 200);
    assert.equal(((await ownerPromotes.json()) as { role: string }).role, 'admin');

    // 把 member 改回来，方便后续用例。
    await store.updateUserRole(member.id, 'member');

    // admin 试图把 member 提升到 admin：应 403（只有 owner 能授予 admin/owner）。
    const adminPromotes = await fetch(`${base}/${member.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(adminPromotes.status, 403);

    // admin 试图修改 owner 的状态：应 403（admin 只能管理 member）。
    const adminTouchesOwner = await fetch(`${base}/${owner.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(adminTouchesOwner.status, 403);

    // 不能改自己。
    const ownerTouchesSelf = await fetch(`${base}/${owner.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(ownerTouchesSelf.status, 403);

    // 不能移除租户唯一的 active owner。
    const removeLastOwner = await fetch(`${base}/${owner.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
      body: JSON.stringify({ role: 'member' }),
    });
    // admin 权限本来就不够（403）；用 owner 自己的 jwt 无法测试因为已经被"不能改自己"拦下。
    // 这里额外造一个新 owner 来验证 409 分支。
    assert.equal(removeLastOwner.status, 403);

    const secondOwner = await store.createUser({ tenantId: 'tn_patch_users', email: 'owner2@patch.test', passwordHash: hashPassword('pw'), role: 'owner' });
    const secondOwnerJwt = signTenantAccessToken({ id: secondOwner.id, tenantId: 'tn_patch_users', role: 'owner' });
    const demoteOnlyOwner = await fetch(`${base}/${owner.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secondOwnerJwt}` },
      body: JSON.stringify({ role: 'member' }),
    });
    // 此时租户有两个 active owner（owner + secondOwner），降级其中一个应该成功。
    assert.equal(demoteOnlyOwner.status, 200);

    // 现在只剩 secondOwner 一个 active owner，尝试降级它应该 409。
    const demoteLastOwner = await fetch(`${base}/${secondOwner.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(demoteLastOwner.status, 409);
  } finally {
    close();
  }
});

test('DELETE /api/tenants/:id/tokens/:tokenId: owner 能吊销 token，吊销后的 token 不能再鉴权；admin 无权吊销', async () => {
  const owner = await seedOwner('tn_revoke_token', 'owner@revoke.test', 'pw');
  const admin = await store.createUser({ tenantId: 'tn_revoke_token', email: 'admin@revoke.test', passwordHash: hashPassword('pw'), role: 'admin' });
  const ownerJwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_revoke_token', role: 'owner' });
  const adminJwt = signTenantAccessToken({ id: admin.id, tenantId: 'tn_revoke_token', role: 'admin' });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api/tenants/tn_revoke_token`;

    const created = await fetch(`${base}/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ label: 'ci' }),
    });
    const { id: tokenId, token } = (await created.json()) as { id: string; token: string };

    // admin 无权吊销 token（token 管理是 owner-only）。
    const adminRevokes = await fetch(`${base}/tokens/${tokenId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminJwt}` } });
    assert.equal(adminRevokes.status, 403);

    // token 吊销前能正常鉴权。
    const beforeRevoke = await fetch(`${base}/tokens`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(beforeRevoke.status, 200);

    const ownerRevokes = await fetch(`${base}/tokens/${tokenId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerJwt}` } });
    assert.equal(ownerRevokes.status, 204);

    // 吊销后不能再用该 token 鉴权。
    const afterRevoke = await fetch(`${base}/tokens`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(afterRevoke.status, 401);
  } finally {
    close();
  }
});
