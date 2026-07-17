import { Router } from 'express';
import { store } from '../store/index.js';
import { getIdentity } from '../auth/context.js';
import { requireMatchingTenantParam, requireOwner, requireOwnerOrAdmin } from '../auth/guards.js';
import { hashPassword } from '../auth/passwords.js';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.js';
import { toApiTokenSummary, toUserSummary } from '../auth/view.js';
import type { CreateApiTokenInput, CreateApiTokenResponse, CreateUserInput } from '@runforge/contracts';

export const tenantsApi = Router();

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
