import { Router } from 'express';
import { store } from '../store/index.js';
import { config } from '../config.js';
import { verifyPassword } from '../auth/passwords.js';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.js';
import { signTenantAccessToken } from '../auth/jwt.js';
import { toUserSummary } from '../auth/view.js';
import type { LoginRequest, LoginResponse, RefreshRequest, RefreshResponse } from '@runforge/contracts';

export const authApi = Router();

const DEFAULT_TENANT_ID = 'default';

authApi.post('/login', async (req, res) => {
  const body = req.body as Partial<LoginRequest> | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const tenantId = typeof body?.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : DEFAULT_TENANT_ID;
  if (!email || !password) {
    res.status(400).json({ error: '缺少 email 或 password' });
    return;
  }

  const user = await store.findUserByEmail(tenantId, email);
  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: '邮箱或密码错误' });
    return;
  }
  // 系统管理员可以禁用整个租户(PATCH /api/system/tenants/:id);这里必须同步检查,
  // 否则"禁用租户"只是改了一个没人看的字段,被禁用租户的用户还能正常登录。
  const tenant = await store.findTenant(tenantId);
  if (!tenant || tenant.status !== 'active') {
    res.status(401).json({ error: '租户不可用' });
    return;
  }

  const accessToken = signTenantAccessToken({ id: user.id, tenantId: user.tenant_id, role: user.role });
  const refreshToken = generateOpaqueToken();
  await store.createAuthToken({
    tenantId: user.tenant_id,
    userId: user.id,
    kind: 'refresh',
    tokenHash: hashOpaqueToken(refreshToken),
    expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000).toISOString(),
  });

  const response: LoginResponse = { accessToken, refreshToken, user: toUserSummary(user) };
  res.json(response);
});

authApi.post('/refresh', async (req, res) => {
  const body = req.body as Partial<RefreshRequest> | undefined;
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (!refreshToken) {
    res.status(400).json({ error: '缺少 refreshToken' });
    return;
  }

  const record = await store.findAuthTokenByHash(hashOpaqueToken(refreshToken));
  if (!record || record.kind !== 'refresh' || record.revoked_at) {
    res.status(401).json({ error: 'refresh token 无效或已吊销' });
    return;
  }
  if (record.expires_at && Date.parse(record.expires_at) < Date.now()) {
    res.status(401).json({ error: 'refresh token 已过期' });
    return;
  }

  const user = await store.findUserById(record.user_id);
  if (!user || user.status !== 'active') {
    res.status(401).json({ error: '账号不可用' });
    return;
  }
  const tenant = await store.findTenant(user.tenant_id);
  if (!tenant || tenant.status !== 'active') {
    res.status(401).json({ error: '租户不可用' });
    return;
  }

  const accessToken = signTenantAccessToken({ id: user.id, tenantId: user.tenant_id, role: user.role });
  const response: RefreshResponse = { accessToken };
  res.json(response);
});

authApi.post('/logout', async (req, res) => {
  const body = req.body as Partial<RefreshRequest> | undefined;
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (refreshToken) {
    const record = await store.findAuthTokenByHash(hashOpaqueToken(refreshToken));
    // 幂等:token 不存在、已吊销或类型不对都当作"已登出"处理，不额外报错。
    if (record && record.kind === 'refresh' && !record.revoked_at) {
      await store.revokeAuthToken(record.id);
    }
  }
  res.status(204).send();
});
