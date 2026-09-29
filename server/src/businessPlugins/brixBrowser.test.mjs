import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrixClient } from '../../../plugins/business/brix/skills/brix-browser/scripts/brix-client.mjs';
import { execute } from '../../../plugins/business/brix/skills/brix-browser/scripts/lens.mjs';

async function fixture(scriptExists) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let value = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { value += chunk; });
      request.on('end', () => resolve(value));
    });
    calls.push({ method: request.method, url: request.url, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/scripts/google-lens') {
      response.statusCode = scriptExists ? 200 : 404;
      response.end(scriptExists ? '{"meta":{}}' : '{"error":"not_found"}');
      return;
    }
    if (request.method === 'PUT' && request.url === '/scripts/google-lens') {
      response.end('{"meta":{}}');
      return;
    }
    if (request.method === 'POST' && request.url === '/sessions') {
      response.end('{"sessionId":"s1"}');
      return;
    }
    if (request.method === 'POST' && request.url === '/sessions/s1/scripts/google-lens') {
      response.end('{"runId":"r1","output":{"pages":[{"title":"来源","url":"https://example.com"}]}}');
      return;
    }
    if (request.method === 'DELETE' && request.url === '/sessions/s1') {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 500;
    response.end('{"error":"unexpected"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { calls, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('脚本缺失时保存规范脚本后执行 Lens，并关闭 session', async () => {
  const target = await fixture(false);
  const dir = await mkdtemp(join(tmpdir(), 'brix-lens-'));
  const image = join(dir, 'image.png');
  const source = join(dir, 'google-lens.ts');
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(source, 'export const script = true;');
  try {
    const output = await execute(image, { scriptPath: source, client: new BrixClient(target.baseUrl, 'token') });
    assert.equal(output.output.pages[0].title, '来源');
    assert.deepEqual(target.calls.map(({ method, url }) => `${method} ${url}`), [
      'GET /scripts/google-lens', 'PUT /scripts/google-lens', 'POST /sessions',
      'POST /sessions/s1/scripts/google-lens', 'DELETE /sessions/s1',
    ]);
    const saved = JSON.parse(target.calls[1].body);
    assert.equal(saved.source, 'export const script = true;');
    const executed = JSON.parse(target.calls[3].body);
    assert.match(executed.args.image, /^data:image\/png;base64,/);
  } finally {
    await new Promise((resolve) => target.server.close(resolve));
  }
});

test('服务端已有脚本时不覆盖', async () => {
  const target = await fixture(true);
  try {
    const client = new BrixClient(target.baseUrl, 'token');
    assert.equal(await client.ensureScript('google-lens', 'replacement', 'ts'), false);
    assert.deepEqual(target.calls.map(({ method, url }) => `${method} ${url}`), ['GET /scripts/google-lens']);
  } finally {
    await new Promise((resolve) => target.server.close(resolve));
  }
});
