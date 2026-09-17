import { Router, type Response } from 'express';
import { store } from '../store/index.js';
import { getIdentity } from '../auth/context.js';
import { requireMatchingTenantParam, requireOwner, requireOwnerOrAdmin } from '../auth/guards.js';
import { hashPassword } from '../auth/passwords.js';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.js';
import { toApiTokenSummary, toUserSummary } from '../auth/view.js';
import type {
  CreateApiTokenInput,
  CreateApiTokenResponse,
  CreateUserInput,
  UpdateBusinessPluginSettingsInput,
  UpdateUserInput,
} from '@runforge/contracts';
import { loadBusinessPluginAdminView, updateBusinessPluginAdminView } from '../businessPlugins/settings.js';
import { BusinessPluginError } from '../businessPlugins/errors.js';

export const tenantsApi = Router();

function handleBusinessPluginError(res: Response, error: unknown) {
  if (error instanceof BusinessPluginError) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: (error as Error).message });
}

// 给前端"我是谁"用(判断要不要显示管理后台入口、角色相关的 UI 分支)。
// 不在前端解码 JWT payload 猜角色——这里是权威来源。
tenantsApi.get('/me', async (_req, res) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  const user = await store.findUserById(identity.userId);
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  res.json(toUserSummary(user));
});

tenantsApi.get('/:id/business-plugins', requireMatchingTenantParam('id'), requireOwnerOrAdmin, async (req, res) => {
  try {
    res.json(await loadBusinessPluginAdminView(req.params.id));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

tenantsApi.put('/:id/business-plugins', requireMatchingTenantParam('id'), requireOwnerOrAdmin, async (req, res) => {
  try {
    res.json(await updateBusinessPluginAdminView(
      req.params.id,
      (req.body ?? {}) as UpdateBusinessPluginSettingsInput,
    ));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

tenantsApi.post('/:id/business-plugins/reload', requireMatchingTenantParam('id'), requireOwnerOrAdmin, async (req, res) => {
  try {
    res.json(await loadBusinessPluginAdminView(req.params.id, true));
  } catch (error) {
    handleBusinessPluginError(res, error);
  }
});

tenantsApi.post('/:id/tokens', requireMatchingTenantParam('id'), requireOwner, async (req, res) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  const body = req.body as Partial<CreateApiTokenInput> | undefined;
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : null;

  const token = generateOpaqueToken();
  const row = await store.createAuthToken({
    tenantId: identity.tenantId,
    userId: identity.userId,
    kind: 'api',
    tokenHash: hashOpaqueToken(token),
    label,
  });
  const response: CreateApiTokenResponse = { ...toApiTokenSummary(row), token };
  res.status(201).json(response);
});

tenantsApi.get('/:id/tokens', requireMatchingTenantParam('id'), requireOwner, async (req, res) => {
  const rows = await store.listApiTokensByTenant(req.params.id);
  res.json({ tokens: rows.map(toApiTokenSummary) });
});

tenantsApi.post('/:id/users', requireMatchingTenantParam('id'), requireOwnerOrAdmin, async (req, res) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  const body = req.body as Partial<CreateUserInput> | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const requestedRole = body?.role ?? 'member';
  if (!email || !password) {
    res.status(400).json({ error: '缺少 email 或 password' });
    return;
  }
  // admin 只能建 member;只有 owner 能把新用户设成 admin/owner(docs/multi-tenancy-design.md §4)。
  if (requestedRole !== 'member' && identity.role !== 'owner') {
    res.status(403).json({ error: '只有 owner 能创建 admin 或 owner 账号' });
    return;
  }

  const existing = await store.findUserByEmail(identity.tenantId, email);
  if (existing) {
    res.status(409).json({ error: '该邮箱在当前租户下已存在' });
    return;
  }

  const user = await store.createUser({
    tenantId: identity.tenantId,
    email,
    passwordHash: hashPassword(password),
    role: requestedRole,
  });
  res.status(201).json(toUserSummary(user));
});

tenantsApi.get('/:id/users', requireMatchingTenantParam('id'), requireOwnerOrAdmin, async (req, res) => {
  const rows = await store.listUsersByTenant(req.params.id);
  res.json({ users: rows.map(toUserSummary) });
});

tenantsApi.patch('/:id/users/:userId', requireMatchingTenantParam('id'), requireOwnerOrAdmin, async (req, res) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  const body = req.body as Partial<UpdateUserInput> | undefined;
  const nextEmail = typeof body?.email === 'string' ? body.email.trim() : undefined;
  const nextPassword = typeof body?.password === 'string' ? body.password : undefined;
  const nextRole = body?.role;
  const nextStatus = body?.status;
  if (nextEmail === undefined && nextPassword === undefined && nextRole === undefined && nextStatus === undefined) {
    res.status(400).json({ error: '缺少可更新字段' });
    return;
  }
  if (nextEmail !== undefined && !nextEmail) {
    res.status(400).json({ error: 'email 不能为空' });
    return;
  }
  if (nextPassword !== undefined && !nextPassword) {
    res.status(400).json({ error: 'password 不能为空' });
    return;
  }
  if (nextRole !== undefined && nextRole !== 'owner' && nextRole !== 'admin' && nextRole !== 'member') {
    res.status(400).json({ error: 'role 必须是 owner / admin / member' });
    return;
  }
  if (nextStatus !== undefined && nextStatus !== 'active' && nextStatus !== 'disabled') {
    res.status(400).json({ error: 'status 必须是 active / disabled' });
    return;
  }

  const target = await store.findUserById(req.params.userId);
  if (!target || target.tenant_id !== identity.tenantId) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  // 自己可以更新登录信息，但不能更改自己的角色或状态，避免误操作把自己锁死。
  if (target.id === identity.userId && (nextRole !== undefined || nextStatus !== undefined)) {
    res.status(403).json({ error: '不能修改自己的角色或状态' });
    return;
  }

  // admin 角色限制,和创建用户时"admin 只能给 member"对称
  // (docs/multi-tenancy-design.md §4):admin 既不能动 owner/admin 账号,
  // 也不能把任何人的角色设成非 member。
  if (identity.role === 'admin') {
    if (target.id !== identity.userId && target.role !== 'member') {
      res.status(403).json({ error: 'admin 只能管理 member 账号' });
      return;
    }
    if (nextRole !== undefined && nextRole !== 'member') {
      res.status(403).json({ error: '只有 owner 能设置 admin 或 owner 角色' });
      return;
    }
  }

  if (nextEmail !== undefined && nextEmail !== target.email) {
    const existing = await store.findUserByEmail(identity.tenantId, nextEmail);
    if (existing && existing.id !== target.id) {
      res.status(409).json({ error: '该邮箱在当前租户下已存在' });
      return;
    }
  }

  // 防止租户变成没有 active owner 的死租户:这次操作如果会让 target 从
  // "active 的 owner"变成"不是",要确认租户里还有别的 active owner。
  const willLoseOwnerStatus =
    target.role === 'owner' &&
    target.status === 'active' &&
    ((nextRole !== undefined && nextRole !== 'owner') || (nextStatus !== undefined && nextStatus !== 'active'));
  if (willLoseOwnerStatus) {
    const users = await store.listUsersByTenant(identity.tenantId);
    const hasOtherActiveOwner = users.some((u) => u.id !== target.id && u.role === 'owner' && u.status === 'active');
    if (!hasOtherActiveOwner) {
      res.status(409).json({ error: '不能移除租户唯一的 active owner' });
      return;
    }
  }

  const updated = await store.updateUser(target.id, {
    email: nextEmail,
    passwordHash: nextPassword === undefined ? undefined : hashPassword(nextPassword),
    role: nextRole,
    status: nextStatus,
  });
  if (!updated) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  // 密码重置后立即吊销旧的交互登录凭证，避免旧会话继续长期有效。
  if (nextPassword !== undefined) await store.revokeRefreshTokensByUser(target.id);
  res.json(toUserSummary(updated));
});

tenantsApi.delete('/:id/tokens/:tokenId', requireMatchingTenantParam('id'), requireOwner, async (req, res) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  const tokens = await store.listApiTokensByTenant(identity.tenantId);
  const target = tokens.find((t) => t.id === req.params.tokenId);
  if (!target) {
    res.status(404).json({ error: 'token 不存在' });
    return;
  }
  await store.revokeAuthToken(target.id);
  res.status(204).send();
});
