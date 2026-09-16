import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { requireApiAccess, signFileShare } from './auth.js';
import { attachWebSocket } from './ws.js';
import { getIdentity } from '../auth/context.js';
import { signSystemAccessToken, signTenantAccessToken } from '../auth/jwt.js';
import { store } from '../store/index.js';
import { spaceAccess } from '../spaces/access.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { ExternalCallerAccess } from '../external/types.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { runBus } from '../agent/bus.js';
import type { ExternalWebSocketFrame } from '@runforge/contracts';

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function tokenProtocol(token: string): string {
  return `runforge-token.${Buffer.from(token, 'utf8').toString('base64url')}`;
}

test('api auth middleware resolves tenant identity from a valid JWT and rejects invalid tokens', async () => {
  const previousJwtSecret = config.auth.jwtSecret;
  config.auth.jwtSecret = 'test-jwt-secret';
  const app = express();
  app.use(requireApiAccess);
  app.get('/ok', (_req, res) => res.json({ ok: true, identity: getIdentity() ?? null }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const base = `http://127.0.0.1:${port}/ok`;
    assert.equal((await fetch(base)).status, 401);
    // 两个 '.' 但签名/内容不对：走 JWT 路径，验签失败，不查库。
    assert.equal((await fetch(base, { headers: { Authorization: 'Bearer a.b.c' } })).status, 401);

    const token = signTenantAccessToken({ id: 'us_1', tenantId: 'tn_1', role: 'owner' });
    const good = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(good.status, 200);
    const body = (await good.json()) as { ok: boolean; identity: unknown };
    assert.deepEqual(body.identity, { scope: 'tenant', tenantId: 'tn_1', userId: 'us_1', role: 'owner' });
  } finally {
    server.close();
    config.auth.jwtSecret = previousJwtSecret;
  }
});

test('api auth middleware lets workload runtime requests through without establishing identity', async () => {
  const app = express();
  app.use(requireApiAccess);
  app.post('/runtime/datasources/:id/credentials', (_req, res) => res.json({ ok: true, identity: getIdentity() ?? null }));
  app.post('/runtime-capabilities/credentials', (_req, res) => res.json({ ok: true, identity: getIdentity() ?? null }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    // workload token(既不是 JWT 也不在 auth_tokens 表里)不应该在这里被 401 挡住——
    // /runtime 由 runtimeApi 自己校验 workload token,不建立租户身份(见 auth.ts 的 isRuntimeRequest)。
    const res = await fetch(`http://127.0.0.1:${port}/runtime/datasources/ds_1/credentials`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wlt_some-workload-token' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { identity: unknown };
    assert.equal(body.identity, null);
    const capabilityRes = await fetch(`http://127.0.0.1:${port}/runtime-capabilities/credentials`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wlt_some-workload-token' },
    });
    assert.equal(capabilityRes.status, 200);
    const capabilityBody = (await capabilityRes.json()) as { identity: unknown };
    assert.equal(capabilityBody.identity, null);
  } finally {
    server.close();
  }
});

test('api auth middleware allows signed file raw, text preview, hex preview and pdf preview requests', async () => {
  const previousShareSecret = config.auth.shareSecret;
  config.auth.shareSecret = 'test-share-secret';
  const app = express();
  app.use(requireApiAccess);
  app.get('/files/raw', (_req, res) => res.json({ ok: true }));
  app.get('/files/preview', (_req, res) => res.json({ ok: true }));
  app.get('/files/hex', (_req, res) => res.json({ ok: true }));
  app.get('/files/pdf-preview', (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const expires = 2_000_000_000;
    const sig = signFileShare('artifacts/report.html', 'default', 'us_share', expires);
    const query = `path=artifacts%2Freport.html&tenant=default&user=us_share&expires=${expires}&sig=${sig}`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/raw?${query}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/preview?${query}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/hex?${query}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/pdf-preview?${query}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/preview?path=artifacts%2Freport.html`)).status, 401);
  } finally {
    server.close();
    config.auth.shareSecret = previousShareSecret;
  }
});

test('websocket auth accepts a valid JWT and rejects missing or opaque tokens', async () => {
  const previousJwtSecret = config.auth.jwtSecret;
  config.auth.jwtSecret = 'test-jwt-secret';
  const server = createServer();
  attachWebSocket(server);
  const port = await listen(server);
  try {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=shell&threadId=th_test`, ['runforge-auth']);
      ws.on('close', (code) => {
        assert.equal(code, 1008);
        resolve();
      });
    });

    // 老的不透明 token 不再被 WebSocket 接受：WS 只认 access JWT(docs/multi-tenancy-design.md §4)。
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=shell&threadId=th_test`, ['runforge-auth', tokenProtocol('legacy-opaque-token')]);
      ws.on('close', (code) => {
        assert.equal(code, 1008);
        resolve();
      });
    });

    // 系统管理员 JWT 也打不了 run/shell 事件订阅——这些是租户用户的资源，系统管理员
    // 不能借着一个合法的系统管理员 JWT 去订阅任意 runId/threadId 的事件流(docs/multi-tenancy-design.md §4)。
    const systemToken = signSystemAccessToken({ id: 'sa_1' });
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=shell&threadId=th_test`, ['runforge-auth', tokenProtocol(systemToken)]);
      ws.on('close', (code) => {
        assert.equal(code, 1008);
        resolve();
      });
    });

    const token = signTenantAccessToken({ id: 'us_1', tenantId: 'tn_1', role: 'owner' });
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=shell&threadId=th_test`, ['runforge-auth', tokenProtocol(token)]);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  } finally {
    server.close();
    config.auth.jwtSecret = previousJwtSecret;
  }
});

test('external websocket: UUID Token 鉴权后按 events.id 回放并从 cursor 续传', async () => {
  const eventStore = new MemoryStore();
  const externalScope = { tenantId: 'tn_external_ws', userId: 'us_external_ws' };
  const thread = await eventStore.createThread(externalScope, 'external websocket');
  const run = await eventStore.createRun(externalScope, thread.id, 'stream events');
  await eventStore.addEvent(externalScope, run.id, null, { type: 'step_start', step: 1 });
  const uuidToken = '123e4567-e89b-42d3-a456-426614174000';
  const access: ExternalCallerAccess = {
    caller: {
      id: 'ec_external_ws',
      tenantId: externalScope.tenantId,
      spaceId: 'sp_external_ws',
      name: 'External WS',
      status: 'active',
      metadata: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    token: {
      id: 'et_external_ws',
      callerId: 'ec_external_ws',
      label: null,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date(0).toISOString(),
    },
    space: {
      id: 'sp_external_ws',
      tenant_id: externalScope.tenantId,
      mode: 'external',
      name: 'External WS',
      execution_user_id: externalScope.userId,
      config: {},
      config_version: 1,
      created_by_user_id: null,
      visible_user_ids: [],
      deleted_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
  };
  let observedHash = '';
  const repository = {
    authenticateToken: async (tokenHash: string) => {
      observedHash = tokenHash;
      return access;
    },
    getRun: async (_access: ExternalCallerAccess, runId: string) => runId === run.id
      ? {
          executionUserId: externalScope.userId,
          response: {
            operation: 'run.get' as const,
            threadId: thread.id,
            runId: run.id,
            status: 'running' as const,
            input: run.input,
            output: null,
            error: null,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
          },
        }
      : null,
  };
  const server = createServer();
  attachWebSocket(server, {
    externalEventStore: eventStore,
    externalRepository: repository,
    externalPollIntervalMs: 20,
  });
  const port = await listen(server);

  const subscribe = (cursor: number, onFrame?: (frame: ExternalWebSocketFrame) => Promise<void> | void) => new Promise<ExternalWebSocketFrame[]>((resolve, reject) => {
    const frames: ExternalWebSocketFrame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/external/${uuidToken}`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', runId: run.id, cursor })));
    ws.on('message', async (data) => {
      const frame = JSON.parse(data.toString()) as ExternalWebSocketFrame;
      frames.push(frame);
      try {
        await onFrame?.(frame);
      } catch (error) {
        reject(error);
        ws.close();
      }
    });
    ws.on('close', (code) => {
      try {
        assert.equal(code, 1000);
        resolve(frames);
      } catch (error) {
        reject(error);
      }
    });
    ws.on('error', reject);
  });

  try {
    let finalAdded = false;
    const firstFrames = await subscribe(0, async (frame) => {
      if (frame.type !== 'event' || frame.event.type !== 'step_start' || finalAdded) return;
      finalAdded = true;
      const final = { type: 'final' as const, step: 1, output: 'done' };
      await eventStore.addEvent(externalScope, run.id, null, final);
      runBus.publish(run.id, final);
    });
    assert.equal(observedHash, hashOpaqueToken(uuidToken));
    assert.deepEqual(firstFrames.map((frame) => frame.type === 'event'
      ? [frame.type, frame.cursor, frame.event.type]
      : [frame.type, 'cursor' in frame ? frame.cursor : null]), [
      ['subscribed', 0],
      ['event', 1, 'step_start'],
      ['event', 2, 'final'],
    ]);

    const resumedFrames = await subscribe(1);
    assert.deepEqual(resumedFrames.map((frame) => frame.type === 'event'
      ? [frame.type, frame.cursor, frame.event.type]
      : [frame.type, 'cursor' in frame ? frame.cursor : null]), [
      ['subscribed', 1],
      ['event', 2, 'final'],
    ]);
  } finally {
    server.close();
  }
});

test('Phase 2: websocket 订阅前按 scope 校验归属，跨租户/跨用户订阅被 1008 拒绝', async () => {
  const previousJwtSecret = config.auth.jwtSecret;
  config.auth.jwtSecret = 'test-jwt-secret';
  const server = createServer();
  attachWebSocket(server);
  const port = await listen(server);
  try {
    const provisioned = await store.createTenantWithOwner({
      id: 'tn_ws_a',
      name: 'WS A',
      ownerEmail: 'owner@ws-a.test',
      ownerPasswordHash: 'test-only',
      settingsTemplate: [],
    });
    const scopeA = { tenantId: provisioned.tenant.id, userId: provisioned.owner.id };
    const thread = await store.createThread(scopeA, 'ws-isolation-thread');
    const ownerTokenA = signTenantAccessToken({ id: provisioned.owner.id, tenantId: provisioned.tenant.id, role: 'owner' });
    const otherTenantToken = signTenantAccessToken({ id: 'us_ws_b', tenantId: 'tn_ws_b', role: 'owner' });

    // 自己 thread 的订阅正常建立，不会被 1008 关闭。
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=shell&threadId=${thread.id}`, ['runforge-auth', tokenProtocol(ownerTokenA)]);
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 200);
      ws.on('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`unexpected close before timeout: ${code}`));
      });
      ws.on('error', reject);
    });

    // 另一个租户拿着合法 JWT 订阅这个 thread，必须被 1008 拒绝。
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=shell&threadId=${thread.id}`, ['runforge-auth', tokenProtocol(otherTenantToken)]);
      ws.on('close', (code) => {
        assert.equal(code, 1008);
        resolve();
      });
      ws.on('error', reject);
    });

    // runId 频道同理：不存在/不属于自己的 run 直接拒绝。
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?runId=ru_does_not_exist`, ['runforge-auth', tokenProtocol(ownerTokenA)]);
      ws.on('close', (code) => {
        assert.equal(code, 1008);
        resolve();
      });
      ws.on('error', reject);
    });
  } finally {
    server.close();
    config.auth.jwtSecret = previousJwtSecret;
  }
});

test('websocket 订阅会复核最新空间可见名单', async () => {
  const previousJwtSecret = config.auth.jwtSecret;
  config.auth.jwtSecret = 'test-jwt-secret';
  const provisioned = await store.createTenantWithOwner({
    id: 'tn_ws_space_visibility',
    name: 'WS Space Visibility',
    ownerEmail: 'owner@ws-space.test',
    ownerPasswordHash: 'test-only',
    settingsTemplate: [],
  });
  const member = await store.createUser({
    tenantId: provisioned.tenant.id,
    email: 'member@ws-space.test',
    passwordHash: 'test-only',
    role: 'member',
  });
  const ownerIdentity = {
    scope: 'tenant' as const,
    tenantId: provisioned.tenant.id,
    userId: provisioned.owner.id,
    role: 'owner' as const,
  };
  const space = await spaceAccess.create(ownerIdentity, {
    mode: 'web',
    name: 'WS Visible Space',
    visibleUserIds: [member.id],
  });
  const scope = { tenantId: provisioned.tenant.id, userId: member.id };
  const thread = await store.createThread(scope, 'visible before revoke', { spaceId: space.id });
  const run = await store.createRun(scope, thread.id, 'visible before revoke');
  await spaceAccess.update(ownerIdentity, space.id, { visibleUserIds: [] });

  const server = createServer();
  attachWebSocket(server);
  const port = await listen(server);
  const token = signTenantAccessToken({ id: member.id, tenantId: provisioned.tenant.id, role: 'member' });
  try {
    for (const target of [
      `channel=shell&threadId=${thread.id}`,
      `runId=${run.id}`,
    ]) {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${target}`, ['runforge-auth', tokenProtocol(token)]);
        ws.on('close', (code) => {
          try {
            assert.equal(code, 1008);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        ws.on('error', reject);
      });
    }
  } finally {
    server.close();
    config.auth.jwtSecret = previousJwtSecret;
  }
});
