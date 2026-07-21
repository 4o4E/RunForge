import { Router } from 'express';
import { store } from '../store/index.js';
import { config } from '../config.js';
import { verifyPassword } from '../auth/passwords.js';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/tokens.js';
import { signSystemAccessToken } from '../auth/jwt.js';
import type { RefreshRequest, RefreshResponse, SystemLoginRequest, SystemLoginResponse } from '@runforge/contracts';

export const systemAuthApi = Router();

systemAuthApi.post('/login', async (req, res) => {
  const body = req.body as Partial<SystemLoginRequest> | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    res.status(400).json({ error: '缺少 email 或 password' });
    return;
  }

  const admin = await store.findSystemAdminByEmail(email);
  if (!admin || admin.status !== 'active' || !verifyPassword(password, admin.password_hash)) {
    res.status(401).json({ error: '邮箱或密码错误' });
    return;
  }

  const accessToken = signSystemAccessToken({ id: admin.id });
  const refreshToken = generateOpaqueToken();
  await store.createSystemAdminToken({
    systemAdminId: admin.id,
    tokenHash: hashOpaqueToken(refreshToken),
    expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000).toISOString(),
  });

  const response: SystemLoginResponse = { accessToken, refreshToken };
  res.json(response);
});

systemAuthApi.post('/refresh', async (req, res) => {
  const body = req.body as Partial<RefreshRequest> | undefined;
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (!refreshToken) {
    res.status(400).json({ error: '缺少 refreshToken' });
    return;
  }

  const record = await store.findSystemAdminTokenByHash(hashOpaqueToken(refreshToken));
  if (!record || record.revoked_at) {
    res.status(401).json({ error: 'refresh token 无效或已吊销' });
    return;
  }
  if (record.expires_at && Date.parse(record.expires_at) < Date.now()) {
    res.status(401).json({ error: 'refresh token 已过期' });
    return;
  }

  const admin = await store.findSystemAdminById(record.system_admin_id);
  if (!admin || admin.status !== 'active') {
    res.status(401).json({ error: '账号不可用' });
    return;
  }

  const accessToken = signSystemAccessToken({ id: admin.id });
  const response: RefreshResponse = { accessToken };
  res.json(response);
});

systemAuthApi.post('/logout', async (req, res) => {
  const body = req.body as Partial<RefreshRequest> | undefined;
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (refreshToken) {
    const record = await store.findSystemAdminTokenByHash(hashOpaqueToken(refreshToken));
    // 幂等:token 不存在或已吊销都当作"已登出"处理，不额外报错。
    if (record && !record.revoked_at) {
      await store.revokeSystemAdminToken(record.id);
    }
  }
  res.status(204).send();
});
