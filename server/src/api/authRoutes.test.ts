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
import { registerRunExecution, retainRunExecution } from '../agent/executionControl.js';
import { stopThreadsForDeletion } from '../deletion/runtime.js';
import { deletionGate } from '../deletion/gate.js';

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
  const provisioned = await store.createTenantWithOwner({
    id: tenantId,
    name: tenantId,
    ownerEmail: email,
    ownerPasswordHash: hashPassword(password),
    settingsTemplate: [],
  });
  return provisioned.owner;
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

test('Phase 2: 两个租户各自的 thread 互相不可见（tenant_id 半边隔离）', async () => {
  const ownerA = await seedOwner('tn_iso_a', 'owner@iso-a.test', 'pw');
  const ownerB = await seedOwner('tn_iso_b', 'owner@iso-b.test', 'pw');
  const jwtA = signTenantAccessToken({ id: ownerA.id, tenantId: 'tn_iso_a', role: 'owner' });
  const jwtB = signTenantAccessToken({ id: ownerB.id, tenantId: 'tn_iso_b', role: 'owner' });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;

    const created = await fetch(`${base}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtA}` },
      body: JSON.stringify({ title: 'tenant-a-private-thread' }),
    });
    assert.equal(created.status, 201);
    const thread = (await created.json()) as { id: string };

    // tenant B 看不到 tenant A 的 thread：既不在列表里，直接按 id 取也是 404。
    const listAsB = await fetch(`${base}/threads`, { headers: { Authorization: `Bearer ${jwtB}` } });
    const listBody = (await listAsB.json()) as Array<{ id: string }>;
    assert.equal(listBody.some((item) => item.id === thread.id), false);

    const getAsB = await fetch(`${base}/threads/${thread.id}`, { headers: { Authorization: `Bearer ${jwtB}` } });
    assert.equal(getAsB.status, 404);

    // tenant A 自己能正常看到。
    const getAsA = await fetch(`${base}/threads/${thread.id}`, { headers: { Authorization: `Bearer ${jwtA}` } });
    assert.equal(getAsA.status, 200);
  } finally {
    close();
  }
});

test('Phase 2: 同一租户下不同用户互相看不到对方的 thread（user_id 半边隔离）', async () => {
  const owner = await seedOwner('tn_iso_users', 'owner@iso-users.test', 'pw');
  const member = await store.createUser({ tenantId: 'tn_iso_users', email: 'member@iso-users.test', passwordHash: hashPassword('pw'), role: 'member' });
  const ownerJwt = signTenantAccessToken({ id: owner.id, tenantId: 'tn_iso_users', role: 'owner' });
  const memberJwt = signTenantAccessToken({ id: member.id, tenantId: 'tn_iso_users', role: 'member' });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api`;

    const created = await fetch(`${base}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ title: 'owner-private-thread' }),
    });
    const thread = (await created.json()) as { id: string };

    const listAsMember = await fetch(`${base}/threads`, { headers: { Authorization: `Bearer ${memberJwt}` } });
    const listBody = (await listAsMember.json()) as Array<{ id: string }>;
    assert.equal(listBody.some((item) => item.id === thread.id), false);

    const getAsMember = await fetch(`${base}/threads/${thread.id}`, { headers: { Authorization: `Bearer ${memberJwt}` } });
    assert.equal(getAsMember.status, 404);
  } finally {
    close();
  }
});

test('GET /api/threads/:id: 用户正文始终返回，原始工具载荷只在显式 Debug 模式返回', async () => {
  const owner = await seedOwner('tn_debug_context', 'owner@debug-context.test', 'pw');
  const member = await store.createUser({
    tenantId: 'tn_debug_context',
    email: 'member@debug-context.test',
    passwordHash: hashPassword('pw'),
    role: 'member',
  });
  const scope = { tenantId: 'tn_debug_context', userId: owner.id };
  const jwt = signTenantAccessToken({ id: owner.id, tenantId: scope.tenantId, role: 'owner' });
  const memberJwt = signTenantAccessToken({ id: member.id, tenantId: scope.tenantId, role: 'member' });
  const thread = await store.createThread(scope, 'debug context');
  const run = await store.createRun(scope, thread.id, 'inspect');
  const step = await store.createStep(scope, run.id, 1);
  await store.saveStepContext(scope, step.id, {
    messages: [
      { role: 'system', content: 'actual system prompt' },
      { role: 'user', content: 'actual user prompt' },
    ],
    tools: [{ name: 'shell', description: '执行命令', parameters: { type: 'object' } }],
    stream: true,
    capturedAt: new Date().toISOString(),
  });
  await store.setRunStatus(scope, run.id, 'done');
  const inactiveRun = await store.createRun(scope, thread.id, 'inactive branch', { parentRunId: run.id });
  const inactiveStep = await store.createStep(scope, inactiveRun.id, 2);
  await store.saveStepContext(scope, inactiveStep.id, {
    messages: [{ role: 'user', content: 'inactive branch prompt' }],
    tools: [],
    stream: true,
    capturedAt: new Date().toISOString(),
  });
  await store.setRunStatus(scope, inactiveRun.id, 'done');
  const activeRun = await store.createRun(scope, thread.id, 'active branch', { parentRunId: run.id });
  const activeStep = await store.createStep(scope, activeRun.id, 2);
  await store.saveStepContext(scope, activeStep.id, {
    messages: [
      { role: 'system', content: 'active system prompt' },
      { role: 'user', content: 'active branch prompt' },
    ],
    tools: [],
    stream: true,
    capturedAt: new Date().toISOString(),
  });
  await store.addMessage(scope, thread.id, run.id, null, {
    role: 'user',
    content: '持久化用户消息',
  });
  const assistantId = await store.addMessage(scope, thread.id, run.id, null, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call_debug', name: 'shell', arguments: '{"command":"echo raw"}' }],
  });
  await store.addMessage(scope, thread.id, run.id, null, {
    role: 'tool',
    content: 'raw output',
    toolCallId: 'call_debug',
  });
  await store.markMessagesCollapsed(scope, [assistantId], 'masked');

  const { port, close } = await listen(buildApp());
  try {
    const headers = { Authorization: `Bearer ${jwt}` };
    const normal = await fetch(`http://127.0.0.1:${port}/api/threads/${thread.id}`, { headers });
    const normalBody = (await normal.json()) as { debug: boolean; context_messages: Array<{ content?: string; tool_calls: Array<{ arguments?: string }> }> };
    assert.equal(normalBody.debug, false);
    assert.equal(normalBody.context_messages.length, 2);
    assert.equal(normalBody.context_messages.some((message) => message.content === '持久化用户消息'), true);
    assert.equal(normalBody.context_messages.some((message) => message.content === 'raw output'), false);
    assert.equal(normalBody.context_messages.some((message) => message.tool_calls.some((call) => call.arguments !== undefined)), false);

    const debug = await fetch(`http://127.0.0.1:${port}/api/threads/${thread.id}?debug=1`, { headers });
    const debugBody = (await debug.json()) as { debug: boolean; context_messages: Array<{ content?: string; tool_calls: Array<{ arguments?: string }> }> };
    assert.equal(debugBody.debug, true);
    assert.equal(debugBody.context_messages.some((message) => message.content === 'raw output'), true);
    assert.equal(debugBody.context_messages.some((message) => message.tool_calls.some((call) => call.arguments === '{"command":"echo raw"}')), true);

    const snapshots = await fetch(`http://127.0.0.1:${port}/api/threads/${thread.id}/context-snapshots`, { headers });
    assert.equal(snapshots.status, 200);
    const snapshotBody = (await snapshots.json()) as {
      systemPrompt: string | null;
      contexts: Array<{ stepId: string; step: number; messageCount: number; toolCount: number }>;
    };
    assert.equal(snapshotBody.contexts.length, 2);
    assert.equal(snapshotBody.contexts[0].messageCount, 2);
    assert.equal(snapshotBody.contexts[0].toolCount, 1);
    assert.equal(snapshotBody.systemPrompt, 'active system prompt');
    assert.equal(snapshotBody.contexts.some((context) => context.stepId === activeStep.id), true);
    assert.equal(snapshotBody.contexts.some((context) => context.stepId === inactiveStep.id), false);

    const snapshot = await fetch(
      `http://127.0.0.1:${port}/api/threads/${thread.id}/context-snapshots/${snapshotBody.contexts[0].stepId}`,
      { headers },
    );
    assert.equal(snapshot.status, 200);
    const context = (await snapshot.json()) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ name: string }>;
    };
    assert.deepEqual(context.messages.map((message) => [message.role, message.content]), [
      ['system', 'actual system prompt'],
      ['user', 'actual user prompt'],
    ]);
    assert.deepEqual(context.tools.map((tool) => tool.name), ['shell']);

    const inactiveSnapshot = await fetch(
      `http://127.0.0.1:${port}/api/threads/${thread.id}/context-snapshots/${inactiveStep.id}`,
      { headers },
    );
    assert.equal(inactiveSnapshot.status, 404);

    const memberSnapshots = await fetch(
      `http://127.0.0.1:${port}/api/threads/${thread.id}/context-snapshots`,
      { headers: { Authorization: `Bearer ${memberJwt}` } },
    );
    assert.equal(memberSnapshots.status, 403);
  } finally {
    close();
  }
});

test('POST /api/threads/:id/runs: 活动 run 冲突返回结构化 RUN_ACTIVE', async () => {
  const owner = await seedOwner('tn_run_active', 'owner@run-active.test', 'pw');
  const scope = { tenantId: 'tn_run_active', userId: owner.id };
  const jwt = signTenantAccessToken({ id: owner.id, tenantId: scope.tenantId, role: 'owner' });
  const thread = await store.createThread(scope, 'run active');
  const activeRun = await store.createRun(scope, thread.id, 'first');
  const { port, close } = await listen(buildApp());
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ input: 'second' }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      code: string;
      currentRunId: string;
      currentStatus: string;
    };
    assert.equal(body.code, 'RUN_ACTIVE');
    assert.equal(body.currentRunId, activeRun.id);
    assert.equal(body.currentStatus, 'pending');
  } finally {
    close();
  }
});

test('DELETE /api/threads/:id: 只永久删除已归档对话并主动停止运行资源', async () => {
  const owner = await seedOwner('tn_delete_threads', 'owner@delete-threads.test', 'pw');
  const scope = { tenantId: 'tn_delete_threads', userId: owner.id };
  const jwt = signTenantAccessToken({ id: owner.id, tenantId: scope.tenantId, role: 'owner' });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
  const deletable = await store.createThread(scope, '可删除对话');
  const active = await store.createThread(scope, '运行中对话');
  const activeShell = await store.createThread(scope, 'Shell 运行中对话');
  await store.createRun(scope, active.id, 'running');
  await store.updateThread(scope, active.id, { archived: true });
  await store.updateThread(scope, activeShell.id, { archived: true });
  const shellSession = await store.createShellSession(scope, {
    threadId: activeShell.id,
    name: 'Default',
    owner: 'user',
    workspaceRoot: '/tmp/runforge-delete-shell-test',
    backend: 'none',
  });
  await store.createShellCommand(scope, {
    sessionId: shellSession.id,
    actor: 'user',
    command: 'sleep 60',
    cwd: '/tmp/runforge-delete-shell-test',
    waitMode: 'background',
  });
  const { port, close } = await listen(buildApp());
  try {
    const base = `http://127.0.0.1:${port}/api/threads`;
    const unarchived = await fetch(`${base}/${deletable.id}`, { method: 'DELETE', headers });
    assert.equal(unarchived.status, 409);
    assert.equal(((await unarchived.json()) as { code: string }).code, 'THREAD_NOT_ARCHIVED');

    const archived = await fetch(`${base}/${deletable.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ archived: true }),
    });
    assert.equal(archived.status, 200);
    assert.equal((await fetch(`${base}/${deletable.id}`, { method: 'DELETE', headers })).status, 204);
    assert.equal(await store.getThread(scope, deletable.id), null);

    const activeDelete = await fetch(`${base}/${active.id}`, { method: 'DELETE', headers });
    assert.equal(activeDelete.status, 204);
    assert.equal(await store.getThread(scope, active.id), null);

    const activeShellDelete = await fetch(`${base}/${activeShell.id}`, { method: 'DELETE', headers });
    assert.equal(activeShellDelete.status, 204);
    assert.equal(await store.getThread(scope, activeShell.id), null);
  } finally {
    close();
  }
});

test('资源删除会主动中止并等待当前进程中的 executor', async () => {
  const owner = await seedOwner('tn_delete_executor', 'owner@delete-executor.test', 'pw');
  const scope = { tenantId: 'tn_delete_executor', userId: owner.id };
  const thread = await store.createThread(scope, '活动 executor');
  const run = await store.createRun(scope, thread.id, 'running');
  const registration = registerRunExecution(run.id);

  const stopping = stopThreadsForDeletion([thread]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(registration.signal.aborted, true);
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  registration.finish();
  await stopping;
  assert.equal((await store.getRun(scope, run.id))?.status, 'canceled');
});

test('资源删除会中止并等待终态 run 留下的后台子任务', async () => {
  const owner = await seedOwner('tn_delete_subagent', 'owner@delete-subagent.test', 'pw');
  const scope = { tenantId: 'tn_delete_subagent', userId: owner.id };
  const thread = await store.createThread(scope, '后台子任务');
  const run = await store.createRun(scope, thread.id, 'done');
  await store.setRunStatus(scope, run.id, 'done');
  const executor = registerRunExecution(run.id);
  executor.bindThread(thread.id);
  const subagent = retainRunExecution(run.id);
  executor.finish();
  const resumedExecutor = registerRunExecution(run.id);
  resumedExecutor.bindThread(thread.id);
  resumedExecutor.finish();

  const stopping = stopThreadsForDeletion([thread]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(subagent.signal.aborted, true);
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  subagent.finish();
  await stopping;
});

test('删除 gate 会等待已经接纳的写入并拒绝同范围的新写入', async () => {
  const scope = { tenantId: 'tn_delete_gate', spaceId: 'sp_delete_gate', threadId: 'th_delete_gate' };
  const operation = deletionGate.enter(scope);
  const deletion = deletionGate.begin({ tenantId: scope.tenantId, spaceId: scope.spaceId });
  deletion.addThreads([scope.threadId]);
  try {
    let waiting = true;
    const pending = deletion.waitForOperations().then(() => { waiting = false; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(waiting, true);
    assert.throws(() => deletionGate.enter(scope), /资源正在删除/);
    operation.finish();
    await pending;
    assert.equal(waiting, false);
  } finally {
    operation.finish();
    deletion.finish();
  }
});
