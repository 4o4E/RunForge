import { Router } from 'express';
import { store } from '../store/index.js';
import { verifyPassword } from '../auth/passwords.js';
import { signSystemAccessToken } from '../auth/jwt.js';
import type { SystemLoginRequest, SystemLoginResponse } from '@runforge/contracts';

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
  const response: SystemLoginResponse = { accessToken };
  res.json(response);
});
