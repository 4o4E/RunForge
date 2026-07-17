import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { config } from '../config.js';
import { api } from './http.js';
import { store } from '../store/index.js';
import { hashPassword } from '../auth/passwords.js';
import { signTenantAccessToken } from '../auth/jwt.js';

// STORE=memory(见 package.json test 脚本)让 ./http.js 里的路由触达的单例 store
// 解析成 MemoryStore，不依赖真实 Postgres。每个用例用独立的 tenant/email，避免
// node:test 并发跑同文件顶层用例时互相踩踏共享的 store 状态。

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  return app;
}

function listen(app: express.Express): Promise<{ port: number; close: () => void }> {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

async function seedOwner(tenantId: string, email: string, password: string) {
  await store.createTenant({ id: tenantId, name: tenantId });
  return store.createUser({ tenantId, email, passwordHash: hashPassword(password), role: 'owner' });
}

test.before(() => {
  config.auth.jwtSecret = config.auth.jwtSecret || 'test-jwt-secret';
});

test('POST /api/auth/login: correct password succeeds, wrong password 401', async () => {
  await seedOwner('tn_login', 'owner@login.test', 'correct-password');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api/auth`;
    const bad = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@login.test', password: 'wrong', tenantId: 'tn_login' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@login.test', password: 'correct-password', tenantId: 'tn_login' }),
    });
    assert.equal(good.status, 200);
    const body = (await good.json()) as { accessToken: string; refreshToken: string; user: { role: string; email: string } };
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
    assert.equal(body.user.role, 'owner');
    assert.equal(body.user.email, 'owner@login.test');
  } finally {
    close();
  }
});

test('POST /api/auth/refresh + /logout: refresh works until logout revokes it', async () => {
  await seedOwner('tn_refresh', 'owner@refresh.test', 'pw');
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api/auth`;
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@refresh.test', password: 'pw', tenantId: 'tn_refresh' }),
    });
    const { refreshToken } = (await login.json()) as { refreshToken: string };

    const refreshed = await fetch(`${base}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(refreshed.status, 200);
    assert.ok(((await refreshed.json()) as { accessToken: string }).accessToken);

    const loggedOut = await fetch(`${base}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(loggedOut.status, 204);

    const afterLogout = await fetch(`${base}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    close();
  }
});

test('POST /api/tenants/:id/tokens: owner-only, tenant-scoped; issued token authenticates via the opaque dual-path', async () => {
  const owner = await seedOwner('tn_tokens', 'owner@tokens.test', 'pw');
  const member = await store.createUser({ tenantId: 'tn_tokens', email: 'member@tokens.test', passwordHash: hashPassword('pw'), role: 'member' });
  const ownerJwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_tokens', role: 'owner' });
  const memberJwt = signTenantAccessToken({ id: member.id, tenantId: 'tn_tokens', role: 'member' });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;

    const asMember = await fetch(`${base}/tenants/tn_tokens/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberJwt}` },
      body: JSON.stringify({ label: 'ci' }),
    });
    assert.equal(asMember.status, 403);

    const wrongTenant = await fetch(`${base}/tenants/tn_other/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ label: 'ci' }),
    });
    assert.equal(wrongTenant.status, 403);

    const asOwner = await fetch(`${base}/tenants/tn_tokens/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ label: 'ci' }),
    });
    assert.equal(asOwner.status, 201);
    const { token } = (await asOwner.json()) as { token: string };
    assert.ok(token.startsWith('atk_'));

    // 不透明 API token 走双路径解析的 hash 查表分支，能打通受保护的 REST 接口。
    const usingApiToken = await fetch(`${base}/tenants/tn_tokens/tokens`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(usingApiToken.status, 200);
  } finally {
    close();
  }
});

test('POST /api/tenants/:id/users: admin cannot elevate to admin/owner, only owner can', async () => {
  const owner = await seedOwner('tn_users', 'owner@users.test', 'pw');
  const admin = await store.createUser({ tenantId: 'tn_users', email: 'admin@users.test', passwordHash: hashPassword('pw'), role: 'admin' });
  const ownerJwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_users', role: 'owner' });
  const adminJwt = signTenantAccessToken({ id: admin.id, tenantId: 'tn_users', role: 'admin' });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api/tenants/tn_users/users`;

    const adminTriesElevate = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
      body: JSON.stringify({ email: 'new-admin@users.test', password: 'pw', role: 'admin' }),
    });
    assert.equal(adminTriesElevate.status, 403);

    const adminCreatesMember = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
      body: JSON.stringify({ email: 'new-member@users.test', password: 'pw' }),
    });
    assert.equal(adminCreatesMember.status, 201);

    const ownerElevates = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ email: 'new-admin-2@users.test', password: 'pw', role: 'admin' }),
    });
    assert.equal(ownerElevates.status, 201);
  } finally {
    close();
  }
});

test('system auth: login + cross-scope rejection between tenant and system JWTs', async () => {
  const admin = await store.createSystemAdmin({ email: 'sysadmin@cross.test', passwordHash: hashPassword('sys-pw') });
  const owner = await seedOwner('tn_cross', 'owner@cross.test', 'pw');
  const { port, close } = await listen(buildApp());
  try {
    const login = await fetch(`http://127.0.0.1:${port}/api/system/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sysadmin@cross.test', password: 'sys-pw' }),
    });
    assert.equal(login.status, 200);
    const { accessToken } = (await login.json()) as { accessToken: string };

    const systemList = await fetch(`http://127.0.0.1:${port}/api/system/tenants`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(systemList.status, 200);
    const { tenants } = (await systemList.json()) as { tenants: Array<{ id: string }> };
    assert.ok(tenants.some((t) => t.id === 'tn_cross'));

    // 系统管理员 JWT 打不了租户范围接口。
    const systemTriesTenantRoute = await fetch(`http://127.0.0.1:${port}/api/tenants/tn_cross/users`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(systemTriesTenantRoute.status, 403);

    // 租户 JWT 打不了系统管理接口。
    const tenantJwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_cross', role: 'owner' });
    const tenantTriesSystemRoute = await fetch(`http://127.0.0.1:${port}/api/system/tenants`, {
      headers: { Authorization: `Bearer ${tenantJwt}` },
    });
    assert.equal(tenantTriesSystemRoute.status, 403);

    // 系统管理员 JWT 也打不了普通的租户业务接口(/threads 等)——不能借着系统管理员身份
    // 冒充租户用户去调这些接口(docs/multi-tenancy-design.md §4)。
    const systemTriesThreads = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(systemTriesThreads.status, 403);

    // 租户 JWT 能正常打 /threads(确认总闸没有误伤合法的租户请求)。
    const tenantHitsThreads = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      headers: { Authorization: `Bearer ${tenantJwt}` },
    });
    assert.equal(tenantHitsThreads.status, 200);
  } finally {
    close();
  }
});
