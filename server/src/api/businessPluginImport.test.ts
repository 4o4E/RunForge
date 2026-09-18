import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';

const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-plugin-api-'));
process.env.RUNFORGE_BUSINESS_PLUGIN_ROOTS = importRoot;
process.env.RUNFORGE_JWT_SECRET = 'business-plugin-import-test-secret';

const [testHelpers, jwt] = await Promise.all([
  import('./testHelpers.js'),
  import('../auth/jwt.js'),
]);

function pluginZip(description: string): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from([
    'schemaVersion: 1',
    'id: imported-api',
    'displayName: Imported API',
    `description: ${description}`,
  ].join('\n')), 'runforge.plugin.yaml');
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

test.after(async () => {
  await rm(importRoot, { recursive: true, force: true });
});

test('业务插件导入 API：租户管理员可以新增和覆盖 ZIP，其他格式被拒绝', async () => {
  const owner = await testHelpers.seedOwner('tn_plugin_import_api', 'owner@plugin-import.test', 'pw');
  const systemAdmin = await testHelpers.seedSystemAdmin('sysadmin@plugin-import.test', 'pw');
  const token = jwt.signTenantAccessToken({ id: owner.id, tenantId: owner.tenant_id, role: 'owner' });
  const systemToken = jwt.signSystemAccessToken({ id: systemAdmin.id });
  const { port, close } = await testHelpers.listen(testHelpers.buildApp());
  const url = `http://127.0.0.1:${port}/api/tenants/${owner.tenant_id}/business-plugins/import`;
  try {
    const created = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: await pluginZip('Initial imported plugin.'),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      pluginId: string;
      replaced: boolean;
      view: { plugins: Array<{ id: string; description: string }> };
    };
    assert.equal(createdBody.pluginId, 'imported-api');
    assert.equal(createdBody.replaced, false);
    assert.equal(createdBody.view.plugins[0]?.description, 'Initial imported plugin.');

    const updated = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: await pluginZip('Updated imported plugin.'),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as {
      replaced: boolean;
      view: { plugins: Array<{ description: string }> };
    };
    assert.equal(updatedBody.replaced, true);
    assert.equal(updatedBody.view.plugins[0]?.description, 'Updated imported plugin.');

    const systemUpdated = await fetch(
      `http://127.0.0.1:${port}/api/system/tenants/${owner.tenant_id}/business-plugins/import`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${systemToken}`, 'Content-Type': 'application/zip' },
        body: await pluginZip('System updated plugin.'),
      },
    );
    assert.equal(systemUpdated.status, 200);
    assert.equal(
      ((await systemUpdated.json()) as { view: { plugins: Array<{ description: string }> } }).view.plugins[0]?.description,
      'System updated plugin.',
    );

    const unsupported = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'invalid',
    });
    assert.equal(unsupported.status, 400);
  } finally {
    close();
  }
});
