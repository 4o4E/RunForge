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

test('api auth middleware lets /runtime/* requests through without establishing identity', async () => {
  const app = express();
  app.use(requireApiAccess);
  app.post('/runtime/datasources/:id/credentials', (_req, res) => res.json({ ok: true, identity: getIdentity() ?? null }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    // workload token(既不是 JWT 也不在 auth_tokens 表里)不应该在这里被 401 挡住——
    // /runtime 由 runtimeApi 自己校验 workload token,不建立租户身份(见 auth.ts 的 isRuntimeRequest)。
    const res = await fetch(`http://127.0.0.1:${port}/runtime/datasources/ds_1/credentials`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wat_some-workload-token' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { identity: unknown };
    assert.equal(body.identity, null);
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
    const sig = signFileShare('artifacts/report.html', 'default', expires);
    const query = `path=artifacts%2Freport.html&expires=${expires}&sig=${sig}`;
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

test('Phase 2: websocket 订阅前按 scope 校验归属，跨租户/跨用户订阅被 1008 拒绝', async () => {
  const previousJwtSecret = config.auth.jwtSecret;
  config.auth.jwtSecret = 'test-jwt-secret';
  const server = createServer();
  attachWebSocket(server);
  const port = await listen(server);
  try {
    const scopeA = { tenantId: 'tn_ws_a', userId: 'us_ws_a' };
    const thread = await store.createThread(scopeA, 'ws-isolation-thread');
    const ownerTokenA = signTenantAccessToken({ id: 'us_ws_a', tenantId: 'tn_ws_a', role: 'owner' });
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
