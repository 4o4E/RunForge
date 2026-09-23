import { Router, type Request, type Response } from 'express';
import { store } from '../store/index.js';
import { hashPassword } from '../auth/passwords.js';
import { toSystemAdminSummary, toTenantSummary, toUserSummary } from '../auth/view.js';
import type {
  CreateSystemAdminInput,
  CreateTenantInput,
  CreateTenantResponse,
  UpdateBusinessPluginSettingsInput,
  UpdateTenantStatusInput,
} from '@runforge/contracts';
import {
  getSystemLlmSettings,
  getSystemMcpSettings,
  getSystemRuntimeCapabilitiesSettings,
  getSystemToolSettings,
  getTenantResourceAuthorization,
  llmModelOptions,
  normalizeLlmSettings,
  normalizeMcpSettings,
  saveTenantResourceAuthorization,
  saveLlmSettings,
  saveMcpSettings,
  saveRuntimeCapabilitiesSettings,
  saveToolSettings,
  tenantSettingsTemplateEntries,
} from '../settings.js';
import { getMcpSettingsOptions, getToolSettingsOptions } from './settings.js';
import { pingLlmProvider, probeLlmProviderModels, testLlmProviderChat } from '../llm/probe.js';
import { probeMcpServer } from '../mcp/client.js';
import type { Datasource, LlmProviderSettings, McpServerProbeResult } from '@runforge/contracts';
import type { TenantScope } from '../store/types.js';
import { newTenantId } from '../id.js';
import { getSystemResourceTenantId } from '../systemResourceTenant.js';
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
import {
  importBusinessPluginAdminView,
  loadBusinessPluginAdminView,
  loadBusinessPluginMcpTools,
  uninstallBusinessPluginAdminView,
  updateBusinessPluginAdminView,
} from '../businessPlugins/settings.js';
import { BusinessPluginError } from '../businessPlugins/errors.js';
import {
  businessPluginArchiveBody,
  parseBusinessPluginArchiveRequest,
} from '../businessPlugins/archiveHttp.js';
import {
  createTenantUser,
  deleteTenantUser,
  TenantUserError,
  updateTenantUser,
} from '../tenants/users.js';
import { spaceConfigService } from '../spaces/config.js';
import { deleteTenant, TenantDeletionError } from '../tenants/deletion.js';
import { DeleteConflictError } from '../store/types.js';
import { aggregateUsage, scanStorageUsage } from '../usage/service.js';
import { parseUsageFilter } from './usage.js';

export const systemApi = Router();

systemApi.use('/tenants/:tenantId/spaces', systemSpacesApi);

systemApi.get('/usage/aggregate', async (req, res) => {
  let filter;
  try {
    filter = parseUsageFilter(req);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  try {
    res.json(await aggregateUsage(filter));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

systemApi.post('/usage/storage/refresh', async (_req, res) => {
  try {
    res.json({ capturedAt: (await scanStorageUsage()).toISOString() });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

async function systemResourceScope(): Promise<TenantScope> {
  return { tenantId: await getSystemResourceTenantId() };
}

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

function handleBusinessPluginError(res: Response, error: unknown) {
  if (error instanceof DeleteConflictError) {
    return res.status(409).json({ error: error.message, code: error.code });
  }
  if (error instanceof BusinessPluginError) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: (error as Error).message });
}

function handleTenantUserError(res: Response, error: unknown) {
  if (error instanceof TenantUserError) return res.status(error.status).json({ error: error.message });
  throw error;
}

systemApi.get('/tenants', async (_req, res) => {
  const rows = await store.listTenants();
  res.json({ tenants: rows.map(toTenantSummary) });
});

systemApi.get('/tenants/:tenantId/users', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  const rows = await store.listUsersByTenant(scope.tenantId);
  res.json({ users: rows.map(toUserSummary) });
});

systemApi.post('/tenants/:tenantId/users', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    const user = await createTenantUser(scope.tenantId, { scope: 'system' }, req.body);
    res.status(201).json(toUserSummary(user));
  } catch (error) {
    handleTenantUserError(res, error);
  }
});

systemApi.patch('/tenants/:tenantId/users/:userId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    const user = await updateTenantUser(scope.tenantId, req.params.userId, { scope: 'system' }, req.body);
    res.json(toUserSummary(user));
  } catch (error) {
    handleTenantUserError(res, error);
  }
});

systemApi.delete('/tenants/:tenantId/users/:userId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    await deleteTenantUser(scope.tenantId, req.params.userId, { scope: 'system' });
    res.status(204).send();
  } catch (error) {
    handleTenantUserError(res, error);
  }
});

systemApi.get('/tenants/:tenantId/business-plugins', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await loadBusinessPluginAdminView(scope.tenantId));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

systemApi.post('/tenants/:tenantId/business-plugins/:pluginId/mcp/:serverId/tools', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await loadBusinessPluginMcpTools(scope.tenantId, req.params.pluginId, req.params.serverId));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

systemApi.put('/tenants/:tenantId/business-plugins', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await updateBusinessPluginAdminView(
      scope.tenantId,
      (req.body ?? {}) as UpdateBusinessPluginSettingsInput,
    ));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

systemApi.post('/tenants/:tenantId/business-plugins/reload', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await loadBusinessPluginAdminView(scope.tenantId, true));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

systemApi.post('/tenants/:tenantId/business-plugins/import', businessPluginArchiveBody, async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    const { archive, format } = parseBusinessPluginArchiveRequest(req);
    const result = await importBusinessPluginAdminView(scope.tenantId, archive, format);
    res.status(result.replaced ? 200 : 201).json(result);
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

systemApi.delete('/tenants/:tenantId/business-plugins/:pluginId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  try {
    res.json(await uninstallBusinessPluginAdminView(scope.tenantId, req.params.pluginId));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

// tenant、首个 owner、初始租户设置和 default space 由 Store 在同一事务中创建；任何一步
// 失败都不留下无法登录或缺少运行配置的半成品 tenant。
systemApi.post('/tenants', async (req, res) => {
  const body = req.body as Partial<CreateTenantInput> | undefined;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const ownerEmail = typeof body?.ownerEmail === 'string' ? body.ownerEmail.trim() : '';
  const ownerPassword = typeof body?.ownerPassword === 'string' ? body.ownerPassword : '';
  if (!name || !ownerEmail || !ownerPassword) {
    res.status(400).json({ error: '缺少 name / ownerEmail / ownerPassword' });
    return;
  }

  const id = newTenantId();
  const defaultSpaceConfig = await spaceConfigService.snapshotForCreate(id, 'web', {}, false);

  const { tenant, owner } = await store.createTenantWithOwner({
    id,
    name,
    ownerEmail,
    ownerPasswordHash: hashPassword(ownerPassword),
    settingsTemplate: tenantSettingsTemplateEntries(),
    defaultSpaceConfig,
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

systemApi.delete('/tenants/:id', async (req, res) => {
  try {
    await deleteTenant(req.params.id);
    res.status(204).send();
  } catch (error) {
    if (error instanceof TenantDeletionError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
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

systemApi.delete('/admins/:id', async (req, res) => {
  try {
    const deleted = await store.deleteSystemAdmin(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: '系统管理员不存在' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    if (error instanceof DeleteConflictError) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

// 系统资源在全系统统一维护，使用 bootstrap tenant 的当前 ID 作为内部存储作用域。
systemApi.get('/settings/llm', async (_req, res) => {
  res.json(await getSystemLlmSettings());
});

systemApi.get('/settings/llm/options', async (_req, res) => {
  const settings = await getSystemLlmSettings();
  res.json({
    defaultModelRef: settings.defaultModelRef,
    titleModelRef: settings.titleModelRef,
    models: llmModelOptions(settings),
  });
});

systemApi.put('/settings/llm', async (req, res) => {
  try {
    res.json(await saveLlmSettings(await systemResourceScope(), req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.post('/settings/llm/provider/models', async (req, res) => {
  try {
    res.json(await probeLlmProviderModels(llmProviderFromBody(req.body)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.post('/settings/llm/provider/ping', async (req, res) => {
  res.json(await pingLlmProvider(llmProviderFromBody(req.body)));
});

systemApi.post('/settings/llm/provider/chat-test', async (req, res) => {
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

systemApi.get('/settings/runtime-capabilities', async (_req, res) => {
  res.json(await getSystemRuntimeCapabilitiesSettings());
});

systemApi.put('/settings/runtime-capabilities', async (req, res) => {
  try {
    res.json(await saveRuntimeCapabilitiesSettings(await systemResourceScope(), req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.get('/settings/mcp', async (_req, res) => {
  res.json(await getSystemMcpSettings());
});

systemApi.get('/settings/mcp/options', async (_req, res) => {
  res.json(await getMcpSettingsOptions());
});

systemApi.put('/settings/mcp', async (req, res) => {
  try {
    res.json(await saveMcpSettings(await systemResourceScope(), req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.post('/settings/mcp/server/probe', async (req, res) => {
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

systemApi.get('/settings/tools', async (_req, res) => {
  res.json(await getSystemToolSettings());
});

systemApi.get('/settings/tools/options', async (_req, res) => {
  res.json(await getToolSettingsOptions());
});

systemApi.put('/settings/tools', async (req, res) => {
  try {
    res.json(await saveToolSettings(await systemResourceScope(), req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

systemApi.get('/datasources', async (_req, res) => {
  try {
    res.json({ datasources: (await listDatasources(await systemResourceScope())).map(publicDatasource) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/datasources', async (req, res) => {
  try {
    const datasource = await createDatasource(await systemResourceScope(), req.body);
    res.status(201).json({ datasource: publicDatasource(datasource), poolDefaults: poolDefaults() });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/datasources/test', async (req, res) => {
  try {
    res.json(await testDatasourceDraft(req.body));
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.get('/datasources/:datasourceId', async (req, res) => {
  try {
    const scope = await systemResourceScope();
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

systemApi.patch('/datasources/:datasourceId', async (req, res) => {
  try {
    res.json({ datasource: publicDatasource(await updateDatasource(await systemResourceScope(), req.params.datasourceId, req.body)) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/datasources/:datasourceId/test', async (req, res) => {
  try {
    res.json(await testDatasourceById(await systemResourceScope(), req.params.datasourceId, req.body));
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/datasources/:datasourceId/profiles', async (req, res) => {
  try {
    res.status(201).json({ profile: await createPermissionProfile(await systemResourceScope(), req.params.datasourceId, req.body) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.post('/datasources/:datasourceId/profiles/readonly-default', async (req, res) => {
  try {
    res.status(201).json({ profile: await ensureReadonlyPermissionProfile(await systemResourceScope(), req.params.datasourceId) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

systemApi.patch('/datasources/:datasourceId/profiles/:profileId', async (req, res) => {
  try {
    res.json({ profile: await updatePermissionProfile(await systemResourceScope(), req.params.datasourceId, req.params.profileId, req.body) });
  } catch (err) {
    handleDatasourceError(res, err);
  }
});

async function tenantResourceAuthorizationView(tenantId: string) {
  const [storedAuthorization, llm, resourceScope] = await Promise.all([
    getTenantResourceAuthorization(tenantId),
    getSystemLlmSettings(),
    systemResourceScope(),
  ]);
  const datasources = await listDatasources(resourceScope);
  const knownProviderIds = new Set(llm.providers.map((provider) => provider.id));
  const knownDatasourceIds = new Set(datasources.map((datasource) => datasource.id));
  return {
    authorization: {
      llmProviderIds: storedAuthorization.llmProviderIds.filter((id) => knownProviderIds.has(id)),
      datasourceIds: storedAuthorization.datasourceIds.filter((id) => knownDatasourceIds.has(id)),
    },
    catalog: {
      llmProviders: llm.providers.map((provider) => ({
        id: provider.id,
        label: provider.label || provider.id,
        models: provider.models,
      })),
      datasources: datasources.map((datasource) => ({
        id: datasource.id,
        name: datasource.name,
        type: datasource.type,
        status: datasource.status,
        enabled: datasource.enabled,
      })),
    },
  };
}

systemApi.get('/tenant-access/:tenantId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  res.json(await tenantResourceAuthorizationView(scope.tenantId));
});

systemApi.put('/tenant-access/:tenantId', async (req, res) => {
  const scope = await systemTenantScope(req, res);
  if (!scope) return;
  const [llm, resourceScope] = await Promise.all([getSystemLlmSettings(), systemResourceScope()]);
  const datasources = await listDatasources(resourceScope);
  const requested = req.body && typeof req.body === 'object'
    ? req.body as { llmProviderIds?: unknown; datasourceIds?: unknown }
    : {};
  const llmProviderIds = Array.isArray(requested.llmProviderIds)
    ? requested.llmProviderIds.map(String)
    : [];
  const datasourceIds = Array.isArray(requested.datasourceIds)
    ? requested.datasourceIds.map(String)
    : [];
  const knownProviders = new Set(llm.providers.map((provider) => provider.id));
  const knownDatasources = new Set(datasources.map((datasource) => datasource.id));
  const unknownProviders = llmProviderIds.filter((id) => !knownProviders.has(id));
  const unknownDatasources = datasourceIds.filter((id) => !knownDatasources.has(id));
  if (unknownProviders.length || unknownDatasources.length) {
    res.status(400).json({
      error: `授权包含不存在的系统资源：${[...unknownProviders, ...unknownDatasources].join(', ')}`,
    });
    return;
  }
  await saveTenantResourceAuthorization(scope.tenantId, { llmProviderIds, datasourceIds });
  res.json(await tenantResourceAuthorizationView(scope.tenantId));
});
