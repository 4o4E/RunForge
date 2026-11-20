import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const command = fileURLToPath(new URL('../../../plugins/business/brix/skills/brix-browser/scripts/brix.mjs', import.meta.url));

for (const scenario of ['deployed', 'artifact-only', 'missing', 'disconnected']) {
  test(`RunForge Lens: ${scenario}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'runforge-brix-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const image = join(dir, 'image.png');
    const sdk = join(dir, 'workload-sdk.mjs');
    const calls = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      calls.push({ route: `${request.method} ${request.url}`, body, authorization: request.headers.authorization });
      response.setHeader('Content-Type', 'application/json');
      switch (calls.at(-1).route) {
        case 'POST /sessions': return response.end('{"sessionId":"s1"}');
        case 'POST /sessions/s1/scripts/google-lens':
          if (scenario === 'disconnected') return request.socket.destroy();
          if (scenario === 'missing') {
            response.statusCode = 404;
            return response.end('{"error":"not_found"}');
          }
          if (scenario === 'artifact-only') return response.end('{"runId":"r1","downloads":[{"name":"result.png","bytes":4,"mimeType":"image/png"}]}');
          return response.end('{"runId":"r1","output":{"pages":[{"title":"来源","url":"https://example.com"}]},"downloads":[]}');
        case 'DELETE /sessions/s1':
          response.statusCode = 204;
          return response.end();
        default:
          response.statusCode = 500;
          return response.end('{"error":"unexpected"}');
      }
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(sdk, `
      const secrets = {'brix.base-url': 'http://127.0.0.1:${server.address().port}', 'brix.token': 'workload-token'};
      export class RunForgeWorkloadClient { secrets = { get(key) { return secrets[key]; } }; }
    `);
    const invocation = run(process.execPath, [command, 'remote', 'run', 'google-lens', '--image', image], {
      env: { ...process.env, RUNFORGE_WORKLOAD_SDK: sdk, BRIX_TOKEN: 'must-not-use' },
    });
    if (scenario === 'deployed' || scenario === 'artifact-only') {
      const { stdout } = await invocation;
      const result = JSON.parse(stdout);
      if (scenario === 'deployed') assert.equal(result.output.pages[0].title, '来源');
      else assert.deepEqual(result, {
        runId: 'r1', output: null, downloads: [{ name: 'result.png', bytes: 4, mimeType: 'image/png' }],
      });
    } else {
      await assert.rejects(invocation, (error) => {
        const result = JSON.parse(error.stderr);
        assert.equal(result.error, scenario === 'missing' ? 'not_found' : 'connection_error');
        assert.equal(result.sessionId, 's1');
        return true;
      });
    }
    assert.deepEqual(calls.map(({ route }) => route), [
      'POST /sessions', 'POST /sessions/s1/scripts/google-lens', 'DELETE /sessions/s1',
    ]);
    assert.ok(calls.every(({ authorization }) => authorization === 'Bearer workload-token'));
    assert.equal(JSON.parse(calls[1].body).args.image, 'data:image/png;base64,iVBORw==');
  });
}
