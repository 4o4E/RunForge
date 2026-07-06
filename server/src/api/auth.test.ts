import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { requireApiAccess, signFileShare } from './auth.js';
import { attachWebSocket } from './ws.js';

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

test('api auth middleware requires bearer token', async () => {
  const previousAccessToken = config.auth.accessToken;
  config.auth.accessToken = 'test-access-token';
  const app = express();
  app.use(requireApiAccess);
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const base = `http://127.0.0.1:${port}/ok`;
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const good = await fetch(base, { headers: { Authorization: 'Bearer test-access-token' } });
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { ok: true });
  } finally {
    server.close();
    config.auth.accessToken = previousAccessToken;
  }
});

test('api auth middleware allows signed file raw, text preview and hex preview requests', async () => {
  const previousAccessToken = config.auth.accessToken;
  const previousShareSecret = config.auth.shareSecret;
  config.auth.accessToken = 'test-access-token';
  config.auth.shareSecret = 'test-share-secret';
  const app = express();
  app.use(requireApiAccess);
  app.get('/files/raw', (_req, res) => res.json({ ok: true }));
  app.get('/files/preview', (_req, res) => res.json({ ok: true }));
  app.get('/files/hex', (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const expires = 2_000_000_000;
    const sig = signFileShare('artifacts/report.html', expires);
    const query = `path=artifacts%2Freport.html&expires=${expires}&sig=${sig}`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/raw?${query}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/preview?${query}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/hex?${query}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/files/preview?path=artifacts%2Freport.html`)).status, 401);
  } finally {
    server.close();
    config.auth.accessToken = previousAccessToken;
    config.auth.shareSecret = previousShareSecret;
  }
});

test('websocket auth uses subprotocol token', async () => {
  const previousAccessToken = config.auth.accessToken;
  config.auth.accessToken = 'test-access-token';
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

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=shell&threadId=th_test`, ['runforge-auth', tokenProtocol('test-access-token')]);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  } finally {
    server.close();
    config.auth.accessToken = previousAccessToken;
  }
});
