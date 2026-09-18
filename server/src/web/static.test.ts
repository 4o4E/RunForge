import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { mountWebApp } from './static.js';

test('生产 Web 入口提供静态文件和前端路由，同时保留服务端路径边界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-web-static-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html><body><div id="root"></div></body></html>');
  await writeFile(join(root, 'assets', 'app.js'), 'globalThis.RUNFORGE_WEB = true;');

  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/value', (_req, res) => res.json({ value: 1 }));
  assert.equal(mountWebApp(app, root), root);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;

    const route = await fetch(`${base}/sp_test/th_test`, { headers: { Accept: 'text/html' } });
    assert.equal(route.status, 200);
    assert.match(await route.text(), /id="root"/);

    const systemTenantRoute = await fetch(`${base}/sys-admin/tenants/default/users`, {
      headers: { Accept: 'text/html' },
    });
    assert.equal(systemTenantRoute.status, 200);
    assert.match(await systemTenantRoute.text(), /id="root"/);

    for (const path of ['/sys-admin/tenant-access?tenant=default', '/sys-admin/settings/llm-models']) {
      const systemRoute = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } });
      assert.equal(systemRoute.status, 200);
      assert.match(await systemRoute.text(), /id="root"/);
    }

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /RUNFORGE_WEB/);

    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    assert.deepEqual(await (await fetch(`${base}/api/value`)).json(), { value: 1 });
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    await rm(root, { recursive: true, force: true });
  }
});

test('配置生产 Web 目录时缺少 index.html 会立即终止启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-web-static-invalid-'));
  try {
    assert.throws(() => mountWebApp(express(), root), /缺少 index\.html/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
