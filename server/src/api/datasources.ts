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
import type { Datasource } from '@my-agent/contracts';

export const datasourcesApi = Router();

function handleError(res: import('express').Response, err: unknown) {
  if (err instanceof DatasourceError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: (err as Error).message });
}

function publicDatasource(datasource: DatasourceRow): Datasource {
  const { admin_config: adminConfig, ...safe } = datasource;
  return { ...safe, hasAdminConfig: Object.keys(adminConfig).length > 0 };
}

// 创建数据源元数据。adminConfig 只用于控制面，不会返回给运行容器。
datasourcesApi.post('/', async (req, res) => {
  try {
    const datasource = await createDatasource(req.body);
    res.status(201).json({ datasource: publicDatasource(datasource), poolDefaults: poolDefaults() });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.get('/', async (_req, res) => {
  try {
    res.json({ datasources: (await listDatasources()).map(publicDatasource) });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/test', async (req, res) => {
  try {
    res.json(await testDatasourceDraft(req.body));
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.get('/:id', async (req, res) => {
  try {
    const datasource = await getDatasource(req.params.id);
    if (!datasource) return res.status(404).json({ error: '数据源不存在' });
    const profiles = await listPermissionProfiles(datasource.id);
    const accounts = await listDatasourceAccounts(datasource.id);
    const leases = await listDatasourceLeases(datasource.id);
    res.json({ datasource: publicDatasource(datasource), profiles, accounts, leases });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.patch('/:id', async (req, res) => {
  try {
    const datasource = await updateDatasource(req.params.id, req.body);
    res.json({ datasource: publicDatasource(datasource) });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/test', async (req, res) => {
  try {
    res.json(await testDatasourceById(req.params.id, req.body));
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/profiles', async (req, res) => {
  try {
    const profile = await createPermissionProfile(req.params.id, req.body);
    res.status(201).json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.post('/:id/profiles/readonly-default', async (req, res) => {
  try {
    const profile = await ensureReadonlyPermissionProfile(req.params.id);
    res.status(201).json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});

datasourcesApi.patch('/:id/profiles/:profileId', async (req, res) => {
  try {
    const profile = await updatePermissionProfile(req.params.id, req.params.profileId, req.body);
    res.json({ profile });
  } catch (err) {
    handleError(res, err);
  }
});
