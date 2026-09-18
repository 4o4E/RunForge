import { Router, type Response } from 'express';
import { store } from '../store/index.js';
import { getIdentity } from '../auth/context.js';
import { requireMatchingTenantParam, requireOwner, requireOwnerOrAdmin } from '../auth/guards.js';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.js';
import { toApiTokenSummary, toUserSummary } from '../auth/view.js';
import type {
  CreateApiTokenInput,
  CreateApiTokenResponse,
  UpdateBusinessPluginSettingsInput,
} from '@runforge/contracts';
import { loadBusinessPluginAdminView, updateBusinessPluginAdminView } from '../businessPlugins/settings.js';
import { BusinessPluginError } from '../businessPlugins/errors.js';
import {
  createTenantUser,
  TenantUserError,
  updateTenantUser,
} from '../tenants/users.js';

export const tenantsApi = Router();

function handleBusinessPluginError(res: Response, error: unknown) {
  if (error instanceof BusinessPluginError) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: (error as Error).message });
}

function handleTenantUserError(res: Response, error: unknown) {
  if (error instanceof TenantUserError) return res.status(error.status).json({ error: error.message });
  throw error;
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
  try {
    const user = await createTenantUser(identity.tenantId, {
      scope: 'tenant',
      userId: identity.userId,
      role: identity.role,
    }, req.body);
    res.status(201).json(toUserSummary(user));
  } catch (error) {
    handleTenantUserError(res, error);
  }
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
  try {
    const user = await updateTenantUser(identity.tenantId, req.params.userId, {
      scope: 'tenant',
      userId: identity.userId,
      role: identity.role,
    }, req.body);
    res.json(toUserSummary(user));
  } catch (error) {
    handleTenantUserError(res, error);
  }
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
