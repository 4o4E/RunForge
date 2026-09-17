import { Router } from 'express';
import {
  acquireCredential,
  DatasourceError,
  releaseLease,
  toPublicCredential,
  validateWorkloadToken,
} from '../datasources/accountPool.js';
import { readAuditedWorkloadSecrets } from '../businessPlugins/secretService.js';

export const runtimeApi = Router();

function bearerToken(header: unknown): string {
  const value = typeof header === 'string' ? header : '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) throw new DatasourceError(401, '缺少 Authorization: Bearer <workload token>');
  return match[1].trim();
}

function handleError(res: import('express').Response, err: unknown) {
  if (err instanceof DatasourceError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: (err as Error).message });
}

// Skill 通过统一 Workload SDK 读取当前 tenant Secret。tenant/run 均从现有 WORKLOAD_TOKEN
// 推导；业务插件的 Secret 声明只用于管理员配置和就绪提示，不作为 key 级授权边界。
runtimeApi.post('/secrets/get', async (req, res) => {
  try {
    const rawToken = bearerToken(req.headers.authorization);
    const stepId = typeof req.headers['x-runforge-step-id'] === 'string'
      ? req.headers['x-runforge-step-id'].trim()
      : null;
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key) throw new DatasourceError(400, 'Secret key 为必填');
    const values = await readAuditedWorkloadSecrets(rawToken, 'workload', stepId, [key]);
    if (!Object.hasOwn(values, key)) throw new DatasourceError(404, 'tenant Secret 未配置');
    res.json({ key, value: values[key] });
  } catch (err) {
    handleError(res, err);
  }
});

// 容器脚本调用：用 workload token 换当前 run 独占的数据库临时凭证。
runtimeApi.post('/datasources/:id/credentials', async (req, res) => {
  try {
    const token = bearerToken(req.headers.authorization);
    const profileName = typeof req.body?.profile === 'string' && req.body.profile.trim() ? req.body.profile.trim() : 'readonly';
    const credential = await acquireCredential(token, req.params.id, profileName);
    res.status(201).json(toPublicCredential(credential));
  } catch (err) {
    handleError(res, err);
  }
});

runtimeApi.post('/leases/:id/release', async (req, res) => {
  try {
    const token = bearerToken(req.headers.authorization);
    const validated = await validateWorkloadToken(token);
    await releaseLease(req.params.id, validated.token.run_id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});
