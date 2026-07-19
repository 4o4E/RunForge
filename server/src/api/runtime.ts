import { Router } from 'express';
import {
  acquireCredential,
  createWorkloadToken,
  DatasourceError,
  releaseLease,
  releaseRunLeases,
  toPublicCredential,
  validateWorkloadToken,
} from '../datasources/accountPool.js';
import { store } from '../store/index.js';
import { scopeForThread, type Scope } from '../store/types.js';
import { resolveIdentityFromAuthorizationHeader } from '../auth/resolve.js';

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

// /runtime 接口没有请求身份(workload token 模式)，这里从 runId 反查它所在的
// scope——这个 id 是调用方自己在 body 里提供的，不是已验证的身份，但下游的
// createWorkloadToken 会用它重新走一遍 Store 的 Scope 校验(docs/multi-tenancy-design.md §9)。
async function scopeForRun(runId: string): Promise<Scope> {
  const run = await store.getRunUnscoped(runId);
  if (!run) throw new DatasourceError(404, 'run 不存在');
  const thread = await store.getThreadUnscoped(run.thread_id);
  if (!thread) throw new DatasourceError(404, 'thread 不存在');
  try {
    return scopeForThread(thread);
  } catch {
    // user_id 为空(用户已被删除):按设计这类 thread 对所有人都不可查,对调用方
    // 呈现为"run 不存在"而不是把一个空 scope 传下去。
    throw new DatasourceError(404, 'run 不存在');
  }
}

// /workload-tokens 和 /runs/:id/release-datasource-leases 这两个接口不是"容器脚本用
// workload token 调用"的模式(它们本身就是在铸造/撤销 token,没有已签发的 token 可以校验),
// 从来没有被 isRuntimeRequest 例外之外的任何东西保护过。修 /runtime 鉴权回归时(Step 0)
// 把整个 /runtime/* 从 requireApiAccess 里排除,这两个端点因此意外变成了完全无鉴权——
// 拿到 runId 就能铸造 token/撤销租约,是这次多租户改造实测发现的一个真实鉴权洞。
// 它们也从未被任何进程内代码通过 HTTP 调用(executor.ts/http.ts 都是直接 import 对应函数),
// 所以要求真实租户身份不会破坏任何现有调用路径。
async function requireRunOwnerIdentity(req: import('express').Request, runId: string): Promise<Scope> {
  const identity = await resolveIdentityFromAuthorizationHeader(req.headers.authorization);
  if (!identity || identity.scope !== 'tenant') throw new DatasourceError(401, '缺少或无效的访问 token');
  const scope = await scopeForRun(runId);
  if (identity.tenantId !== scope.tenantId) throw new DatasourceError(403, '无权操作其他租户的 run');
  return scope;
}

// 需要租户身份(见上方注释):为单次 run 签发 workload token。明文 token 只在这里返回一次。
runtimeApi.post('/workload-tokens', async (req, res) => {
  try {
    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
    if (!runId) throw new DatasourceError(400, 'runId 为必填');
    const scope = await requireRunOwnerIdentity(req, runId);
    const created = await createWorkloadToken(scope, req.body);
    res.status(201).json({
      token: created.token,
      id: created.row.id,
      runId: created.row.run_id,
      skillId: created.row.skill_id,
      allowedDatasourceIds: created.row.allowed_datasources,
      expiresAt: created.row.expires_at,
    });
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

// 任务收尾兜底：撤销 run 的所有 workload token，并释放仍在租赁中的账号。需要租户身份(见上方注释)。
runtimeApi.post('/runs/:id/release-datasource-leases', async (req, res) => {
  try {
    await requireRunOwnerIdentity(req, req.params.id);
    const released = await releaseRunLeases(req.params.id);
    res.json({ ok: true, released });
  } catch (err) {
    handleError(res, err);
  }
});
