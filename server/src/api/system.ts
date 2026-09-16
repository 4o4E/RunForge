import { Router, type Request, type Response } from 'express';
import { store } from '../store/index.js';
import { hashPassword } from '../auth/passwords.js';
import { toSystemAdminSummary, toTenantSummary, toUserSummary } from '../auth/view.js';
import type { CreateSystemAdminInput, CreateTenantInput, CreateTenantResponse, UpdateTenantStatusInput } from '@runforge/contracts';
import {
  getLlmSettings,
  getMcpSettings,
  getRuntimeCapabilitiesSettings,
  getToolSettings,
  normalizeLlmSettings,
  normalizeMcpSettings,
  saveLlmSettings,
  saveMcpSettings,
  saveRuntimeCapabilitiesSettings,
  saveToolSettings,
  shellPathForSettings,
  tenantSettingsTemplateEntries,
} from '../settings.js';
import { getLlmSettingsOptions, getMcpSettingsOptions, getToolSettingsOptions, shellCommandOptions } from './settings.js';
import { pingLlmProvider, probeLlmProviderModels, testLlmProviderChat } from '../llm/probe.js';
import { catalogCapability } from '../llm/modelCatalog.js';
import { probeMcpServer } from '../mcp/client.js';
import { scanExecutableNames } from '../tools/sandbox.js';
import type { Datasource, LlmProviderSettings, McpServerProbeResult, ShellCommandScanInput } from '@runforge/contracts';
import type { TenantScope } from '../store/types.js';
import {
  createDatasource,
  createPermissionProfile,
  DatasourceError,
  ensureReadonlyPermissionProfile,
  getDatasource,
  listDatasourceAccounts,
  listDatasourceLeases,
  listDatasources,
  listPermissionProfiles,
  poolDefaults,
  updateDatasource,
  updatePermissionProfile,
} from '../datasources/accountPool.js';
import { testDatasourceById, testDatasourceDraft } from '../datasources/introspection.js';
import type { DatasourceRow } from '../datasources/types.js';
import { systemSpacesApi } from './spaces.js';

export const systemApi = Router();

systemApi.use('/tenants/:tenantId/spaces', systemSpacesApi);

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

async function systemTenantScope(req: Request, res: Response): Promise<TenantScope | null> {
  const tenantId = req.params.tenantId;
  if (!tenantId || !(await store.findTenant(tenantId))) {
    res.status(404).json({ error: '租户不存在' });
    return null;
  }
  return { tenantId };
}

function llmProviderFromBody(body: unknown): LlmProviderSettings {
  const row = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const nestedProvider = row.provider && typeof row.provider === 'object' ? row.provider : row;
  return normalizeLlmSettings({ providers: [nestedProvider] }).providers[0];
}

function publicDatasource(datasource: DatasourceRow): Datasource {
  const { admin_config: adminConfig, ...safe } = datasource;
  return { ...safe, hasAdminConfig: Object.keys(adminConfig).length > 0 };
}

function handleDatasourceError(res: Response, err: unknown) {
  if (err instanceof DatasourceError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: (err as Error).message });
}

systemApi.get('/tenants', async (_req, res) => {
  const rows = await store.listTenants();
  res.json({ tenants: rows.map(toTenantSummary) });
});

// tenant、首个 owner、配置副本和 default space 由 Store 在同一事务中创建；任何一步
// 失败都不留下无法登录或缺少运行配置的半成品 tenant。
systemApi.post('/tenants', async (req, res) => {
  const body = req.body as Partial<CreateTenantInput> | undefined;
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const ownerEmail = typeof body?.ownerEmail === 'string' ? body.ownerEmail.trim() : '';
  const ownerPassword = typeof body?.ownerPassword === 'string' ? body.ownerPassword : '';
  if (!id || !name || !ownerEmail || !ownerPassword) {
    res.status(400).json({ error: '缺少 id / name / ownerEmail / ownerPassword' });
    return;
  }
  if (!TENANT_ID_RE.test(id)) {
    res.status(400).json({ error: 'id 只能包含字母、数字、下划线和短横线，且不能以下划线/短横线开头' });
    return;
  }

  const existing = await store.findTenant(id);
  if (existing) {
    res.status(409).json({ error: '该租户 id 已存在' });
    return;
  }

  const { tenant, owner } = await store.createTenantWithOwner({
    id,
    name,
    ownerEmail,
    ownerPasswordHash: hashPassword(ownerPassword),
    settingsTemplate: tenantSettingsTemplateEntries(),
  });

  const response: CreateTenantResponse = { tenant: toTenantSummary(tenant), owner: toUserSummary(owner) };
  res.status(201).json(response);
});

systemApi.patch('/tenants/:id', async (req, res) => {
  const body = req.body as Partial<UpdateTenantStatusInput> | undefined;
  const status = body?.status;
  if (status !== 'active' && status !== 'suspended') {
    res.status(400).json({ error: 'status 必须是 active 或 suspended' });
    return;
  }

  const existing = await store.findTenant(req.params.id);
  if (!existing) {
    res.status(404).json({ error: '租户不存在' });
    return;
  }

  const updated = await store.updateTenantStatus(req.params.id, status);
  res.json({ tenant: toTenantSummary(updated!) });
});

systemApi.get('/admins', async (_req, res) => {
  const rows = await store.listSystemAdmins();
  res.json({ admins: rows.map(toSystemAdminSummary) });
});

systemApi.post('/admins', async (req, res) => {
  const body = req.body as Partial<CreateSystemAdminInput> | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    res.status(400).json({ error: '缺少 email 或 password' });
    return;
  }

  const existing = await store.findSystemAdminByEmail(email);
  if (existing) {
    res.status(409).json({ error: '该邮箱已注册为系统管理员' });
    return;
  }

  const admin = await store.createSystemAdmin({ email, passwordHash: hashPassword(password) });
  res.status(201).json(toSystemAdminSummary(admin));
});

// 系统配置由系统管理员修改，但值仍按 tenant_id 落库；系统管理员必须先明确选择目标租户。
systemApi.get('/tenants/:tenantId/settings/llm', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (scope) res.json(await getLlmSettings(scope));
});

systemApi.get('/tenants/:tenantId/settings/llm/options', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (scope) res.json(await getLlmSettingsOptions(scope));
});

systemApi.put('/tenants/:tenantId/settings/llm', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await saveLlmSettings(scope, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.post('/tenants/:tenantId/settings/llm/provider/models', async (req, res) => {
  if (!(await systemTenantScope(req, res))) return;
  try {
    res.json(await probeLlmProviderModels(llmProviderFromBody(req.body)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.post('/tenants/:tenantId/settings/llm/model-capability', async (req, res) => {
  if (!(await systemTenantScope(req, res))) return;
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) return res.status(400).json({ error: '缺少模型名称' });
  res.json(catalogCapability(model));
});

systemApi.post('/tenants/:tenantId/settings/llm/provider/ping', async (req, res) => {
  if (!(await systemTenantScope(req, res))) return;
  res.json(await pingLlmProvider(llmProviderFromBody(req.body)));
});

systemApi.post('/tenants/:tenantId/settings/llm/provider/chat-test', async (req, res) => {
  if (!(await systemTenantScope(req, res))) return;
  try {
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    res.json(await testLlmProviderChat(
      llmProviderFromBody(body),
      typeof body.model === 'string' ? body.model : '',
      typeof body.input === 'string' ? body.input : '',
    ));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.get('/tenants/:tenantId/settings/runtime-capabilities', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (scope) res.json(await getRuntimeCapabilitiesSettings(scope));
});

systemApi.put('/tenants/:tenantId/settings/runtime-capabilities', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await saveRuntimeCapabilitiesSettings(scope, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.get('/tenants/:tenantId/settings/mcp', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (scope) res.json(await getMcpSettings(scope));
});

systemApi.get('/tenants/:tenantId/settings/mcp/options', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (scope) res.json(await getMcpSettingsOptions(scope));
});

systemApi.put('/tenants/:tenantId/settings/mcp', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await saveMcpSettings(scope, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.post('/tenants/:tenantId/settings/mcp/server/probe', async (req, res) => {
  if (!(await systemTenantScope(req, res))) return;
  try {
    const settings = normalizeMcpSettings({ servers: [req.body?.server ?? req.body] });
    const server = settings.servers[0];
    const tools = await probeMcpServer(server);
    const result: McpServerProbeResult = {
      ok: true,
      message: `连接成功，发现 ${tools.length} 个工具。`,
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        serverId: tool.serverId,
        serverLabel: tool.serverLabel,
        name: tool.originalName,
        mappedName: tool.mappedName,
        description: tool.description,
      })),
    };
    res.json(result);
  } catch (err) {
    const result: McpServerProbeResult = { ok: false, message: (err as Error).message, toolCount: 0, tools: [] };
    res.status(400).json(result);
  }
});

systemApi.get('/tenants/:tenantId/settings/tools', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (scope) res.json(await getToolSettings(scope));
});

systemApi.get('/tenants/:tenantId/settings/tools/options', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (scope) res.json(await getToolSettingsOptions(scope));
});

systemApi.put('/tenants/:tenantId/settings/tools', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await saveToolSettings(scope, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.post('/tenants/:tenantId/settings/tools/shell-commands/scan', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  const current = await getToolSettings(scope);
  const body = (req.body ?? {}) as Partial<ShellCommandScanInput>;
  const shellPathMode = body.shellPathMode === 'custom' ? 'custom' : 'system';
  const shellPath = typeof body.shellPath === 'string' ? body.shellPath : current.shellPath;
  const include = Array.isArray(body.include) ? body.include.map(String) : current.shellAllowCommands;
  const envPath = shellPathMode === 'custom' ? shellPath : shellPathForSettings({ ...current, shellPathMode: 'system' });
  res.json({ path: envPath, shellCommands: shellCommandOptions([...include, ...scanExecutableNames(envPath)], envPath) });
});

// 数据源包含供应商管理凭证，只通过系统设置写入；所有查询仍由 tenant_id 强制隔离。
systemApi.get('/tenants/:tenantId/datasources', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json({ datasources: (await listDatasources(scope)).map(publicDatasource) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/tenants/:tenantId/datasources', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    const datasource = await createDatasource(scope, req.body);
    res.status(201).json({ datasource: publicDatasource(datasource), poolDefaults: poolDefaults() });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/tenants/:tenantId/datasources/test', async (req, res) => {
  if (!(await systemTenantScope(req, res))) return;
  try {
    res.json(await testDatasourceDraft(req.body));
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.get('/tenants/:tenantId/datasources/:datasourceId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    const datasource = await getDatasource(scope, req.params.datasourceId);
    if (!datasource) return res.status(404).json({ error: '数据源不存在' });
    const profiles = await listPermissionProfiles(scope, datasource.id);
    const accounts = await listDatasourceAccounts(scope, datasource.id);
    const leases = await listDatasourceLeases(scope, datasource.id);
    res.json({ datasource: publicDatasource(datasource), profiles, accounts, leases });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.patch('/tenants/:tenantId/datasources/:datasourceId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json({ datasource: publicDatasource(await updateDatasource(scope, req.params.datasourceId, req.body)) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/tenants/:tenantId/datasources/:datasourceId/test', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await testDatasourceById(scope, req.params.datasourceId, req.body));
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/tenants/:tenantId/datasources/:datasourceId/profiles', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.status(201).json({ profile: await createPermissionProfile(scope, req.params.datasourceId, req.body) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/tenants/:tenantId/datasources/:datasourceId/profiles/readonly-default', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.status(201).json({ profile: await ensureReadonlyPermissionProfile(scope, req.params.datasourceId) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.patch('/tenants/:tenantId/datasources/:datasourceId/profiles/:profileId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json({ profile: await updatePermissionProfile(scope, req.params.datasourceId, req.params.profileId, req.body) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});
