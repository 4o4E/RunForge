import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { getSystemResourceTenantId } from '../systemResourceTenant.js';
import { newTenantId } from '../id.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { buildApp, listen, seedOwner, seedSystemAdmin } from './testHelpers.js';
import { findSetting } from '../store/settingsRepository.js';
import { saveTenantResourceAuthorization } from '../settings.js';
import { store } from '../store/index.js';
import { prisma } from '../db/prisma.js';
import { pool } from '../db/pool.js';

if (process.env.STORE === 'memory') {
  throw new Error('system.postgres.test.ts 必须使用真实 PostgreSQL Store');
}

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

test('系统设置与租户授权接口: system admin 可管理，租户身份不能越权，未知租户返回 404', async () => {
  const tenantId = newTenantId();
  const systemAdminEmail = `sysadmin@${tenantId}.test`;
  let systemAdminId: string | undefined;
  let tenantCreated = false;
  let closeServer: (() => Promise<void>) | undefined;

  try {
    const systemAdmin = await seedSystemAdmin(systemAdminEmail, 'sys-pw');
    systemAdminId = systemAdmin.id;
    const owner = await seedOwner(tenantId, `owner@${tenantId}.test`, 'pw');
    tenantCreated = true;
    const ownerJwt = signTenantAccessToken({ id: owner.id, tenantId, role: 'owner' });
    const { port, close } = await listen(buildApp());
    closeServer = close;
    const base = `http://127.0.0.1:${port}/api`;
    const { accessToken } = await systemLogin(base, systemAdminEmail, 'sys-pw');

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
    const systemTenantId = await getSystemResourceTenantId();
    assert.equal(await findSetting(systemTenantId, 'tools.workspaceRoot'), undefined);

    const systemToolsWrite = await fetch(`${base}/system/settings/tools`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...systemTools, workspaceRoot: '/tmp/request-workspace' }),
    });
    assert.equal(systemToolsWrite.status, 200);
    assert.equal(((await systemToolsWrite.json()) as { workspaceRoot?: unknown }).workspaceRoot, config.tools.workspaceRoot);
    assert.equal(await findSetting(systemTenantId, 'tools.workspaceRoot'), undefined);

    const systemUsers = await fetch(`${base}/system/tenants/${tenantId}/users`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(systemUsers.status, 200);
    const systemUsersText = await systemUsers.text();
    assert.equal(systemUsersText.includes('password_hash'), false);
    assert.deepEqual(
      (JSON.parse(systemUsersText) as { users: Array<{ id: string }> }).users.map((user) => user.id),
      [owner.id],
    );

    const tenantEscalation = await fetch(`${base}/system/settings/llm`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    assert.equal(tenantEscalation.status, 403);

    const tenantUsersEscalation = await fetch(`${base}/system/tenants/${tenantId}/users`, {
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

    const tenantAccess = await fetch(`${base}/system/tenant-access/${tenantId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(tenantAccess.status, 200);
    assert.deepEqual(
      (await tenantAccess.json() as { authorization: { llmProviderIds: string[]; datasourceIds: string[] } }).authorization,
      { llmProviderIds: [], datasourceIds: [] },
    );

    await saveTenantResourceAuthorization(tenantId, {
      llmProviderIds: ['deleted-provider'],
      datasourceIds: ['deleted-datasource'],
    });
    const staleAuthorization = await fetch(`${base}/system/tenant-access/${tenantId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(staleAuthorization.status, 200);
    assert.deepEqual(
      (await staleAuthorization.json() as { authorization: { llmProviderIds: string[]; datasourceIds: string[] } }).authorization,
      { llmProviderIds: [], datasourceIds: [] },
    );

    const invalidAuthorization = await fetch(`${base}/system/tenant-access/${tenantId}`, {
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
    try {
      if (closeServer) await closeServer();
    } finally {
      try {
        if (tenantCreated) await store.deleteTenant(tenantId);
      } finally {
        if (systemAdminId) await store.deleteSystemAdmin(systemAdminId);
      }
    }
  }
});

after(async () => {
  try {
    await prisma.$disconnect();
  } finally {
    await pool.end();
  }
});
