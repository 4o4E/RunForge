import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { buildApp, listen, seedOwner, seedSystemAdmin } from './testHelpers.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { hashPassword } from '../auth/passwords.js';
import { store } from '../store/index.js';
import { saveTenantResourceAuthorization } from '../settings.js';
import { findSetting } from '../store/settingsRepository.js';

test.before(() => {
  config.auth.jwtSecret = config.auth.jwtSecret || 'test-jwt-secret';
});

async function systemLogin(base: string, email: string, password: string) {
  const res = await fetch(`${base}/system/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

test('system auth: 登录返回 refreshToken，refresh/logout 流程可用', async () => {
  await seedSystemAdmin('sysadmin@refresh.test', 'sys-pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken, refreshToken } = await systemLogin(base, 'sysadmin@refresh.test', 'sys-pw');
    assert.ok(accessToken);
    assert.ok(refreshToken);

    const refreshed = await fetch(`${base}/system/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(refreshed.status, 200);
    assert.ok(((await refreshed.json()) as { accessToken: string }).accessToken);

    const loggedOut = await fetch(`${base}/system/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(loggedOut.status, 204);

    const afterLogout = await fetch(`${base}/system/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    close();
  }
});

test('POST /api/system/tenants: 服务端生成租户 ID 并同时创建 owner', async () => {
  await seedSystemAdmin('sysadmin@tenants.test', 'sys-pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, 'sysadmin@tenants.test', 'sys-pw');

    const created = await fetch(`${base}/system/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name: 'Acme', ownerEmail: 'owner@acme.test', ownerPassword: 'Passw0rd!' }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { tenant: { id: string }; owner: { email: string; role: string } };
    assert.match(body.tenant.id, /^tn_[0-9A-Za-z]+$/);
    assert.equal(body.owner.email, 'owner@acme.test');
    assert.equal(body.owner.role, 'owner');

    // 新 owner 应该能直接用普通登录接口登录。
    const ownerLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@acme.test', password: 'Passw0rd!', tenantId: body.tenant.id }),
    });
    assert.equal(ownerLogin.status, 200);

    const sameName = await fetch(`${base}/system/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name: 'Acme', ownerEmail: 'other@acme.test', ownerPassword: 'pw' }),
    });
    assert.equal(sameName.status, 201);
    assert.notEqual(((await sameName.json()) as { tenant: { id: string } }).tenant.id, body.tenant.id);
  } finally {
    close();
  }
});

test('PATCH /api/system/tenants/:id: 禁用租户后该租户的用户登录/refresh 均 401', async () => {
  await seedSystemAdmin('sysadmin@suspend.test', 'sys-pw');
  await seedOwner('tn_suspend', 'owner@suspend.test', 'pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, 'sysadmin@suspend.test', 'sys-pw');

    const loginBeforeSuspend = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@suspend.test', password: 'pw', tenantId: 'tn_suspend' }),
    });
    assert.equal(loginBeforeSuspend.status, 200);
    const { refreshToken } = (await loginBeforeSuspend.json()) as { refreshToken: string };

    const suspended = await fetch(`${base}/system/tenants/tn_suspend`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ status: 'suspended' }),
    });
    assert.equal(suspended.status, 200);
    assert.equal(((await suspended.json()) as { tenant: { status: string } }).tenant.status, 'suspended');

    const loginAfterSuspend = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@suspend.test', password: 'pw', tenantId: 'tn_suspend' }),
    });
    assert.equal(loginAfterSuspend.status, 401);

    const refreshAfterSuspend = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(refreshAfterSuspend.status, 401);
  } finally {
    close();
  }
});

test('系统管理员可以在租户范围内创建和编辑用户，并保证租户至少存在一个 owner', async () => {
  await seedSystemAdmin('sysadmin@tenant-users.test', 'sys-pw');
  const owner = await seedOwner('tn_system_users', 'owner@system-users.test', 'pw');
  const member = await store.createUser({
    tenantId: 'tn_system_users',
    email: 'member@system-users.test',
    passwordHash: hashPassword('old-pw'),
    role: 'member',
  });
  const otherTenantUser = await seedOwner('tn_other_system_users', 'owner@other-system-users.test', 'pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, 'sysadmin@tenant-users.test', 'sys-pw');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };

    const created = await fetch(`${base}/system/tenants/tn_system_users/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'admin@system-users.test', password: 'pw', role: 'admin' }),
    });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { role: string }).role, 'admin');

    const oldLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@system-users.test', password: 'old-pw', tenantId: 'tn_system_users' }),
    });
    assert.equal(oldLogin.status, 200);
    const { refreshToken } = (await oldLogin.json()) as { refreshToken: string };

    const updated = await fetch(`${base}/system/tenants/tn_system_users/users/${member.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ email: 'member-new@system-users.test', password: 'new-pw', role: 'admin' }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as { email: string; role: string };
    assert.equal(updatedBody.email, 'member-new@system-users.test');
    assert.equal(updatedBody.role, 'admin');

    const oldRefresh = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(oldRefresh.status, 401);

    const crossTenant = await fetch(`${base}/system/tenants/tn_system_users/users/${otherTenantUser.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(crossTenant.status, 404);

    const disableOnlyOwner = await fetch(`${base}/system/tenants/tn_system_users/users/${owner.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(disableOnlyOwner.status, 200);

    const demoteOnlyOwner = await fetch(`${base}/system/tenants/tn_system_users/users/${owner.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(demoteOnlyOwner.status, 409);

    const deleteOnlyOwner = await fetch(`${base}/system/tenants/tn_system_users/users/${owner.id}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(deleteOnlyOwner.status, 409);
  } finally {
    close();
  }
});

test('GET/POST /api/system/admins: 列出并创建系统管理员账号', async () => {
  await seedSystemAdmin('sysadmin@admins.test', 'sys-pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, 'sysadmin@admins.test', 'sys-pw');

    const created = await fetch(`${base}/system/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ email: 'new-admin@admins.test', password: 'pw' }),
    });
    assert.equal(created.status, 201);

    const list = await fetch(`${base}/system/admins`, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(list.status, 200);
    const { admins } = (await list.json()) as { admins: Array<{ email: string }> };
    assert.ok(admins.some((a) => a.email === 'new-admin@admins.test'));

    // 新账号应该能直接登录。
    const newAdminLogin = await fetch(`${base}/system/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new-admin@admins.test', password: 'pw' }),
    });
    assert.equal(newAdminLogin.status, 200);

    const duplicate = await fetch(`${base}/system/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ email: 'new-admin@admins.test', password: 'pw2' }),
    });
    assert.equal(duplicate.status, 409);
  } finally {
    close();
  }
});

test('DELETE /api/system/admins/:id: 允许删除普通管理员，保护默认系统管理员', async () => {
  const defaultAdmin = await store.createSystemAdmin({
    email: 'default-sysadmin@delete-admins.test',
    passwordHash: hashPassword('pw'),
    isBootstrap: true,
  });
  const caller = await seedSystemAdmin('caller@delete-admins.test', 'pw');
  const removable = await seedSystemAdmin('remove@delete-admins.test', 'pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, caller.email, 'pw');
    const headers = { Authorization: `Bearer ${accessToken}` };
    assert.equal((await fetch(`${base}/system/admins/${defaultAdmin.id}`, { method: 'DELETE', headers })).status, 409);
    assert.equal((await fetch(`${base}/system/admins/${removable.id}`, { method: 'DELETE', headers })).status, 204);
    assert.equal(await store.findSystemAdminById(removable.id), null);
    assert.equal((await fetch(`${base}/system/admins/${caller.id}`, { method: 'DELETE', headers })).status, 204);
    assert.equal(await store.findSystemAdminById(caller.id), null);
  } finally {
    close();
  }
});

test('DELETE /api/system/tenants/:id: 永久删除普通租户并保护 default 租户', async () => {
  const systemAdmin = await seedSystemAdmin('sysadmin@delete-tenants.test', 'pw');
  const protectedTenant = await store.createTenantWithOwner({
    id: 'tn_default_delete_guard',
    name: 'Default',
    isBootstrap: true,
    ownerEmail: 'owner@default-delete-guard.test',
    ownerPasswordHash: 'pw',
    settingsTemplate: [],
  });
  const removableTenant = await store.createTenantWithOwner({
    id: 'tn_permanent_delete',
    name: 'Delete me',
    ownerEmail: 'owner@permanent-delete.test',
    ownerPasswordHash: 'pw',
    settingsTemplate: [],
  });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, systemAdmin.email, 'pw');
    const headers = { Authorization: `Bearer ${accessToken}` };
    assert.equal((await fetch(`${base}/system/tenants/${protectedTenant.tenant.id}`, { method: 'DELETE', headers })).status, 409);
    assert.equal((await fetch(`${base}/system/tenants/${removableTenant.tenant.id}`, { method: 'DELETE', headers })).status, 204);
    assert.equal(await store.findTenant(removableTenant.tenant.id), null);
    assert.equal(await store.findUserById(removableTenant.owner.id), null);
    assert.equal(await store.findSpace(removableTenant.tenant.id, removableTenant.defaultSpace.id), null);
  } finally {
    close();
  }
});

test('系统设置与租户授权接口: system admin 可管理，租户身份不能越权，未知租户返回 404', async () => {
  await seedSystemAdmin('sysadmin@settings.test', 'sys-pw');
  const owner = await seedOwner('tn_system_settings', 'owner@settings.test', 'pw');
  const ownerJwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_system_settings', role: 'owner' });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, 'sysadmin@settings.test', 'sys-pw');

    const systemRead = await fetch(`${base}/system/settings/llm`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(systemRead.status, 200);

    const systemToolsRead = await fetch(`${base}/system/settings/tools`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(systemToolsRead.status, 200);
    const systemTools = (await systemToolsRead.json()) as { workspaceRoot?: unknown };
    assert.equal(systemTools.workspaceRoot, config.tools.workspaceRoot);
    assert.equal(await findSetting('default', 'tools.workspaceRoot'), undefined);

    const systemToolsWrite = await fetch(`${base}/system/settings/tools`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...systemTools, workspaceRoot: '/tmp/request-workspace' }),
    });
    assert.equal(systemToolsWrite.status, 200);
    assert.equal(((await systemToolsWrite.json()) as { workspaceRoot?: unknown }).workspaceRoot, config.tools.workspaceRoot);
    assert.equal(await findSetting('default', 'tools.workspaceRoot'), undefined);

    const systemUsers = await fetch(`${base}/system/tenants/tn_system_settings/users`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(systemUsers.status, 200);
    const systemUsersText = await systemUsers.text();
    assert.equal(systemUsersText.includes('password_hash'), false);
    assert.deepEqual(
      (JSON.parse(systemUsersText) as { users: Array<{ id: string }> }).users.map((user) => user.id),
      [owner.id],
    );

    const resolvedCapability = await fetch(`${base}/system/settings/llm/model-capability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ model: 'glm-5-2-260617' }),
    });
    assert.equal(resolvedCapability.status, 200);
    assert.equal(((await resolvedCapability.json()) as { contextWindow: number }).contextWindow, 1_000_000);

    const tenantEscalation = await fetch(`${base}/system/settings/llm`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(tenantEscalation.status, 403);

    const tenantUsersEscalation = await fetch(`${base}/system/tenants/tn_system_settings/users`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(tenantUsersEscalation.status, 403);

    const tenantWrite = await fetch(`${base}/settings/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ providers: [] }),
    });
    assert.equal(tenantWrite.status, 403);

    const tenantFullRead = await fetch(`${base}/settings/llm`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(tenantFullRead.status, 403);

    const tenantToolsRead = await fetch(`${base}/settings/tools`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(tenantToolsRead.status, 403);

    const tenantDatasourceDetail = await fetch(`${base}/datasources/ds_not_exposed`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(tenantDatasourceDetail.status, 403);

    const tenantModelOptions = await fetch(`${base}/settings/llm/options`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(tenantModelOptions.status, 200);
    const modelOptionsText = await tenantModelOptions.text();
    assert.equal(modelOptionsText.includes('apiKey'), false);
    assert.equal(modelOptionsText.includes('baseUrl'), false);

    const tenantAccess = await fetch(`${base}/system/tenant-access/tn_system_settings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(tenantAccess.status, 200);
    assert.deepEqual(
      (await tenantAccess.json() as { authorization: { llmProviderIds: string[]; datasourceIds: string[] } }).authorization,
      { llmProviderIds: [], datasourceIds: [] },
    );

    await saveTenantResourceAuthorization('tn_system_settings', {
      llmProviderIds: ['deleted-provider'],
      datasourceIds: ['deleted-datasource'],
    });
    const staleAuthorization = await fetch(`${base}/system/tenant-access/tn_system_settings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(staleAuthorization.status, 200);
    assert.deepEqual(
      (await staleAuthorization.json() as { authorization: { llmProviderIds: string[]; datasourceIds: string[] } }).authorization,
      { llmProviderIds: [], datasourceIds: [] },
    );

    const invalidAuthorization = await fetch(`${base}/system/tenant-access/tn_system_settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ llmProviderIds: ['missing-provider'], datasourceIds: [] }),
    });
    assert.equal(invalidAuthorization.status, 400);

    const missingTenant = await fetch(`${base}/system/tenant-access/not_found`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(missingTenant.status, 404);
  } finally {
    close();
  }
});
