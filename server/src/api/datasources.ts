import { Router } from 'express';
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
import type { Datasource } from '@runforge/contracts';
import { requireOwnerOrAdmin } from '../auth/guards.js';
import { requireScope } from '../auth/context.js';
import type { Response } from 'express';

export const datasourcesApi = Router();

function handleError(res: import('express').Response, err: unknown) {
  if (err instanceof DatasourceError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: (err as Error).message });
}

function scopeOrReject(res: Response): { tenantId: string } | null {
  const scope = requireScope();
  if (!scope) {
    res.status(403).json({ error: '需要租户身份' });
    return null;
  }
  return scope;
}

function publicDatasource(datasource: DatasourceRow): Datasource {
  const { admin_config: adminConfig, ...safe } = datasource;
  return { ...safe, hasAdminConfig: Object.keys(adminConfig).length > 0 };
}

// 创建数据源元数据。adminConfig 只用于控制面，不会返回给运行容器。
// 建/改数据源需要 owner/admin 权限——member 只能读(角色矩阵修复，Phase 2 review 发现)。
datasourcesApi.post('/', requireOwnerOrAdmin, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const datasource = await createDatasource(scope, req.body);
    res.status(201).json({ datasource: publicDatasource(datasource), poolDefaults: poolDefaults() });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.get('/', async (_req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    res.json({ datasources: (await listDatasources(scope)).map(publicDatasource) });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/test', requireOwnerOrAdmin, async (req, res) => {
  try {
    res.json(await testDatasourceDraft(req.body));
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.get('/:id', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const datasource = await getDatasource(scope, req.params.id);
    if (!datasource) return res.status(404).json({ error: '数据源不存在' });
    const profiles = await listPermissionProfiles(scope, datasource.id);
    const accounts = await listDatasourceAccounts(scope, datasource.id);
    const leases = await listDatasourceLeases(scope, datasource.id);
    res.json({ datasource: publicDatasource(datasource), profiles, accounts, leases });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.patch('/:id', requireOwnerOrAdmin, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const datasource = await updateDatasource(scope, req.params.id, req.body);
    res.json({ datasource: publicDatasource(datasource) });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/test', requireOwnerOrAdmin, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    res.json(await testDatasourceById(scope, req.params.id, req.body));
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/profiles', requireOwnerOrAdmin, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const profile = await createPermissionProfile(scope, req.params.id, req.body);
    res.status(201).json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/profiles/readonly-default', requireOwnerOrAdmin, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const profile = await ensureReadonlyPermissionProfile(scope, req.params.id);
    res.status(201).json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.patch('/:id/profiles/:profileId', requireOwnerOrAdmin, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const profile = await updatePermissionProfile(scope, req.params.id, req.params.profileId, req.body);
    res.json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});
