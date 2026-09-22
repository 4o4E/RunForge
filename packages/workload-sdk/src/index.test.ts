import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunForgeWorkloadClient } from './index.js';

test('Workload SDK 只发送统一 token、step 和资源参数，不接受 tenant/plugin 身份', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const url = String(input);
    if (url.endsWith('/secrets/get')) return Response.json({ key: 'crm.api-key', value: 'current-value' });
    if (url.includes('/datasources/')) {
      return Response.json({ leaseId: 'dl_test', type: 'postgres', username: 'reader', password: 'short-lived', expiresAt: new Date(0).toISOString(), connection: {} });
    }
    const capability = JSON.parse(String(init?.body)).capability as 'llm' | 'image';
    return Response.json({ capability, baseUrl: 'http://runtime.test', headers: {}, expiresAt: new Date(0).toISOString(), endpoints: {}, defaults: {}, models: [] });
  };
  const client = new RunForgeWorkloadClient({
    token: 'wlt_test',
    runtimeApiBase: 'http://runforge.test/api/runtime',
    stepId: 'st_test',
    fetch: fetchImpl,
  });

  assert.equal(await client.secrets.get('crm.api-key'), 'current-value');
  assert.equal((await client.resources.acquire('database.readonly', { datasourceId: 'ds_reports', profile: 'reports-readonly' })).username, 'reader');
  assert.equal((await client.resources.acquire('llm.proxy')).capability, 'llm');
  assert.equal((await client.resources.acquire('image.proxy')).capability, 'image');

  assert.deepEqual(requests.map((request) => request.url), [
    'http://runforge.test/api/runtime/secrets/get',
    'http://runforge.test/api/runtime/datasources/ds_reports/credentials',
    'http://runforge.test/api/runtime-capabilities/credentials',
    'http://runforge.test/api/runtime-capabilities/credentials',
  ]);
  for (const request of requests) {
    const headers = new Headers(request.init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer wlt_test');
    assert.equal(headers.get('x-runforge-step-id'), 'st_test');
    const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
    assert.equal('tenantId' in body, false);
    assert.equal('businessPluginId' in body, false);
  }
  assert.equal(JSON.parse(String(requests[1]?.init?.body)).profile, 'reports-readonly');
});
