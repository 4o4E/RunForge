import { Router } from 'express';
import { store } from '../store/index.js';
import { hashPassword } from '../auth/passwords.js';
import { toSystemAdminSummary, toTenantSummary, toUserSummary } from '../auth/view.js';
import type { CreateSystemAdminInput, CreateTenantInput, CreateTenantResponse, UpdateTenantStatusInput } from '@runforge/contracts';

export const systemApi = Router();

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

systemApi.get('/tenants', async (_req, res) => {
  const rows = await store.listTenants();
  res.json({ tenants: rows.map(toTenantSummary) });
});

// 新建租户必须同时建一个 owner,否则新租户没人能登录(参照 auth/bootstrap.ts
// "tenant + owner 一起建"的现有模式)。不用事务包裹——这个代码库目前没有显式事务
// 用法,bootstrap.ts 本身也是分两步裸调用,保持一致。
systemApi.post('/tenants', async (req, res) => {
  const body = req.body as Partial<CreateTenantInput> | undefined;
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const ownerEmail = typeof body?.ownerEmail === 'string' ? body.ownerEmail.trim() : '';
  const ownerPassword = typeof body?.ownerPassword === 'string' ? body.ownerPassword : '';
  if (!id || !name || !ownerEmail || !ownerPassword) {
    res.status(400).json({ error: '缺少 id / name / ownerEmail / ownerPassword' });
    return;
  }
  if (!TENANT_ID_RE.test(id)) {
    res.status(400).json({ error: 'id 只能包含字母、数字、下划线和短横线，且不能以下划线/短横线开头' });
    return;
  }

  const existing = await store.findTenant(id);
  if (existing) {
    res.status(409).json({ error: '该租户 id 已存在' });
    return;
  }

  const tenant = await store.createTenant({ id, name });
  const owner = await store.createUser({
    tenantId: id,
    email: ownerEmail,
    passwordHash: hashPassword(ownerPassword),
    role: 'owner',
  });

  const response: CreateTenantResponse = { tenant: toTenantSummary(tenant), owner: toUserSummary(owner) };
  res.status(201).json(response);
});

systemApi.patch('/tenants/:id', async (req, res) => {
  const body = req.body as Partial<UpdateTenantStatusInput> | undefined;
  const status = body?.status;
  if (status !== 'active' && status !== 'suspended') {
    res.status(400).json({ error: 'status 必须是 active 或 suspended' });
    return;
  }

  const existing = await store.findTenant(req.params.id);
  if (!existing) {
    res.status(404).json({ error: '租户不存在' });
    return;
  }

  const updated = await store.updateTenantStatus(req.params.id, status);
  res.json({ tenant: toTenantSummary(updated!) });
});

systemApi.get('/admins', async (_req, res) => {
  const rows = await store.listSystemAdmins();
  res.json({ admins: rows.map(toSystemAdminSummary) });
});

systemApi.post('/admins', async (req, res) => {
  const body = req.body as Partial<CreateSystemAdminInput> | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    res.status(400).json({ error: '缺少 email 或 password' });
    return;
  }

  const existing = await store.findSystemAdminByEmail(email);
  if (existing) {
    res.status(409).json({ error: '该邮箱已注册为系统管理员' });
    return;
  }

  const admin = await store.createSystemAdmin({ email, passwordHash: hashPassword(password) });
  res.status(201).json(toSystemAdminSummary(admin));
});
