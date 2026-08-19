import { Router } from 'express';
import {
  createDatasource,
  createPermissionProfile,
  DatasourceError,
  ensureReadonlyPermissionProfile,
  listDatasources,
  poolDefaults,
  updateDatasource,
  updatePermissionProfile,
} from '../datasources/accountPool.js';
import { testDatasourceById, testDatasourceDraft } from '../datasources/introspection.js';
import type { DatasourceRow } from '../datasources/types.js';
import type { Datasource } from '@runforge/contracts';
import { rejectSystemManagedAccess } from '../auth/guards.js';
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

// 租户侧只读数据源元数据，供成员选择和运行时展示；管理凭证与写操作统一走系统设置接口。
// adminConfig 只用于系统控制面，不会返回给运行容器或租户侧读取接口。
datasourcesApi.post('/', rejectSystemManagedAccess, async (req, res) => {
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

datasourcesApi.post('/test', rejectSystemManagedAccess, async (req, res) => {
  try {
    res.json(await testDatasourceDraft(req.body));
  } catch (err) {
    handleError(res, err);
  }
});

// 详情包含权限档位、账号池和租约，属于系统控制面；租户用户只保留列表元数据读取。
datasourcesApi.get('/:id', rejectSystemManagedAccess);

datasourcesApi.patch('/:id', rejectSystemManagedAccess, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const datasource = await updateDatasource(scope, req.params.id, req.body);
    res.json({ datasource: publicDatasource(datasource) });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/test', rejectSystemManagedAccess, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    res.json(await testDatasourceById(scope, req.params.id, req.body));
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/profiles', rejectSystemManagedAccess, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const profile = await createPermissionProfile(scope, req.params.id, req.body);
    res.status(201).json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/profiles/readonly-default', rejectSystemManagedAccess, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const profile = await ensureReadonlyPermissionProfile(scope, req.params.id);
    res.status(201).json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.patch('/:id/profiles/:profileId', rejectSystemManagedAccess, async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  try {
    const profile = await updatePermissionProfile(scope, req.params.id, req.params.profileId, req.body);
    res.json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});
