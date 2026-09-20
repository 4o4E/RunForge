import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ZipFile } from 'yazl';

const importRoot = await mkdtemp(join(tmpdir(), 'runforge-business-plugin-api-'));
process.env.RUNFORGE_BUSINESS_PLUGIN_ROOTS = importRoot;
process.env.RUNFORGE_JWT_SECRET = 'business-plugin-import-test-secret';

const [testHelpers, jwt] = await Promise.all([
  import('./testHelpers.js'),
  import('../auth/jwt.js'),
]);
const [{ store }, { getBusinessPluginTenantSettings }] = await Promise.all([
  import('../store/index.js'),
  import('../businessPlugins/settings.js'),
]);

function pluginZip(description: string, options: { id?: string; mcpUrl?: string } = {}): Promise<Buffer> {
  const zip = new ZipFile();
  const manifest = [
    'schemaVersion: 1',
    `id: ${options.id ?? 'imported-api'}`,
    'displayName: Imported API',
    `description: ${description}`,
    'configSchema:',
    '  type: object',
    '  properties:',
    '    region: { type: string }',
    'secrets:',
    '  - key: shared.api-key',
  ];
  if (options.mcpUrl) {
    manifest.push(
      'mcpServers:',
      '  - id: crm',
      '    label: CRM',
      '    description: 查询客户资料',
      `    url: ${options.mcpUrl}`,
    );
  }
  zip.addBuffer(Buffer.from(manifest.join('\n')), 'runforge.plugin.yaml');
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

function selectBusinessPlugins(config: Record<string, unknown>, pluginIds: string[]): Record<string, unknown> {
  const capabilities = config.capabilities as Record<string, unknown>;
  return { ...config, capabilities: { ...capabilities, businessPlugins: pluginIds } };
}

test.after(async () => {
  await rm(importRoot, { recursive: true, force: true });
});

test('业务插件 MCP 预览 API：连接真实 MCP 并返回每个工具的输入 Schema', async () => {
  const mcpApp = createMcpExpressApp();
  mcpApp.post('/mcp', async (req, res) => {
    const mcp = new McpServer({ name: 'business-plugin-preview-test', version: '1.0.0' });
    mcp.registerTool('customer_lookup', {
      description: '按客户编号读取资料',
      inputSchema: { customerId: z.string().describe('客户编号') },
    }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
  });

  const mcpListener = await testHelpers.listen(mcpApp);
  const owner = await testHelpers.seedOwner('tn_plugin_mcp_preview', 'owner@plugin-mcp-preview.test', 'pw');
  const token = jwt.signTenantAccessToken({ id: owner.id, tenantId: owner.tenant_id, role: 'owner' });
  const runforge = await testHelpers.listen(testHelpers.buildApp());
  try {
    const base = `http://127.0.0.1:${runforge.port}/api/tenants/${owner.tenant_id}/business-plugins`;
    const imported = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: await pluginZip('Plugin with MCP.', {
        id: 'mcp-preview',
        mcpUrl: `http://127.0.0.1:${mcpListener.port}/mcp`,
      }),
    });
    assert.equal(imported.status, 201);

    const preview = await fetch(`${base}/mcp-preview/mcp/crm/tools`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(preview.status, 200);
    const body = (await preview.json()) as {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    };
    assert.equal(body.tools[0]?.name, 'customer_lookup');
    assert.match(body.tools[0]?.description ?? '', /按客户编号读取资料/);
    assert.deepEqual(
      (body.tools[0]?.inputSchema.properties as Record<string, unknown>)?.customerId,
      { type: 'string', description: '客户编号' },
    );
  } finally {
    runforge.close();
    mcpListener.close();
  }
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

    const configured = await fetch(url.slice(0, -'/import'.length), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugins: { 'imported-api': { config: { region: 'cn' } } },
        secrets: { 'shared.api-key': 'same-tenant-secret' },
      }),
    });
    assert.equal(configured.status, 200);

    const updated = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: await pluginZip('Updated imported plugin.'),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as {
      replaced: boolean;
      view: {
        plugins: Array<{
          description: string;
          config: Record<string, unknown>;
          secrets: Array<{ key: string; configured: boolean }>;
        }>;
      };
    };
    assert.equal(updatedBody.replaced, true);
    assert.equal(updatedBody.view.plugins[0]?.description, 'Updated imported plugin.');
    assert.deepEqual(updatedBody.view.plugins[0]?.config, { region: 'cn' });
    assert.equal(updatedBody.view.plugins[0]?.secrets[0]?.configured, true);

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

test('业务插件卸载 API：清理有效空间和普通配置，保留 Secret 与历史空间', async () => {
  const owner = await testHelpers.seedOwner('tn_plugin_uninstall_api', 'owner@plugin-uninstall.test', 'pw');
  const member = await store.createUser({
    tenantId: owner.tenant_id,
    email: 'member@plugin-uninstall.test',
    passwordHash: 'unused',
    role: 'member',
  });
  const systemAdmin = await testHelpers.seedSystemAdmin('sysadmin@plugin-uninstall.test', 'pw');
  const ownerToken = jwt.signTenantAccessToken({ id: owner.id, tenantId: owner.tenant_id, role: 'owner' });
  const memberToken = jwt.signTenantAccessToken({ id: member.id, tenantId: member.tenant_id, role: 'member' });
  const systemToken = jwt.signSystemAccessToken({ id: systemAdmin.id });
  const { port, close } = await testHelpers.listen(testHelpers.buildApp());
  const base = `http://127.0.0.1:${port}/api/tenants/${owner.tenant_id}/business-plugins`;
  try {
    const archive = await pluginZip('Plugin that can be uninstalled.');
    const imported = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/zip' },
      body: archive,
    });
    assert.equal(imported.status, 201);

    const configured = await fetch(base, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugins: { 'imported-api': { config: { region: 'cn' } } },
        secrets: { 'shared.api-key': 'same-tenant-secret' },
      }),
    });
    assert.equal(configured.status, 200);

    const defaultSpace = await store.getDefaultSpace(owner.tenant_id);
    assert.ok(defaultSpace);
    const selectedDefault = await store.updateSpace(owner.tenant_id, defaultSpace.id, {
      config: selectBusinessPlugins(defaultSpace.config, ['imported-api']),
    });
    assert.ok(selectedDefault);
    const deletedSpace = await store.createSpace({
      tenantId: owner.tenant_id,
      mode: 'web',
      name: 'Deleted plugin space',
      executionUserId: null,
      config: selectBusinessPlugins(defaultSpace.config, ['imported-api']),
      visibleUserIds: [],
      createdByUserId: owner.id,
    });
    await store.softDeleteSpaceAndRevokeTokens(owner.tenant_id, deletedSpace.id);

    const denied = await fetch(`${base}/imported-api`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(denied.status, 403);

    const removed = await fetch(`${base}/imported-api`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(removed.status, 200);
    const removedBody = (await removed.json()) as {
      affectedSpaces: Array<{ id: string; name: string }>;
      view: { plugins: unknown[] };
    };
    assert.deepEqual(removedBody.affectedSpaces, [{ id: defaultSpace.id, name: defaultSpace.name }]);
    assert.deepEqual(removedBody.view.plugins, []);

    const updatedDefault = await store.findSpace(owner.tenant_id, defaultSpace.id);
    assert.equal(updatedDefault?.config_version, selectedDefault.config_version + 1);
    assert.deepEqual(
      ((updatedDefault?.config as Record<string, unknown>).capabilities as Record<string, unknown>).businessPlugins,
      [],
    );
    const untouchedDeleted = await store.findSpace(owner.tenant_id, deletedSpace.id);
    assert.equal(untouchedDeleted?.config_version, deletedSpace.config_version);
    assert.deepEqual(
      ((untouchedDeleted?.config as Record<string, unknown>).capabilities as Record<string, unknown>).businessPlugins,
      ['imported-api'],
    );
    const removedSettings = await getBusinessPluginTenantSettings(owner.tenant_id);
    assert.equal(Object.hasOwn(removedSettings.plugins, 'imported-api'), false);
    assert.equal(removedSettings.secrets['shared.api-key'], 'same-tenant-secret');

    const reimported = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/zip' },
      body: archive,
    });
    assert.equal(reimported.status, 201);
    const reimportedBody = (await reimported.json()) as {
      replaced: boolean;
      view: { plugins: Array<{ config: Record<string, unknown>; secrets: Array<{ key: string; configured: boolean }> }> };
    };
    assert.equal(reimportedBody.replaced, false);
    assert.deepEqual(reimportedBody.view.plugins[0]?.config, {});
    assert.deepEqual(reimportedBody.view.plugins[0]?.secrets, [{
      key: 'shared.api-key',
      description: '',
      required: true,
      configured: true,
    }]);

    const systemRemoved = await fetch(
      `http://127.0.0.1:${port}/api/system/tenants/${owner.tenant_id}/business-plugins/imported-api`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${systemToken}` } },
    );
    assert.equal(systemRemoved.status, 200);
  } finally {
    close();
  }
});
