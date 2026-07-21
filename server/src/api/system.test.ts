import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { buildApp, listen, seedOwner, seedSystemAdmin } from './testHelpers.js';

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

test('POST /api/system/tenants: 创建租户会同时建一个 owner，重复 id 返回 409', async () => {
  await seedSystemAdmin('sysadmin@tenants.test', 'sys-pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, 'sysadmin@tenants.test', 'sys-pw');

    const created = await fetch(`${base}/system/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ id: 'tn_new_acme', name: 'Acme', ownerEmail: 'owner@acme.test', ownerPassword: 'Passw0rd!' }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { tenant: { id: string }; owner: { email: string; role: string } };
    assert.equal(body.tenant.id, 'tn_new_acme');
    assert.equal(body.owner.email, 'owner@acme.test');
    assert.equal(body.owner.role, 'owner');

    // 新 owner 应该能直接用普通登录接口登录。
    const ownerLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@acme.test', password: 'Passw0rd!', tenantId: 'tn_new_acme' }),
    });
    assert.equal(ownerLogin.status, 200);

    const duplicate = await fetch(`${base}/system/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ id: 'tn_new_acme', name: 'Acme Again', ownerEmail: 'other@acme.test', ownerPassword: 'pw' }),
    });
    assert.equal(duplicate.status, 409);
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
