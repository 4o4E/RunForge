import { Router } from 'express';
import { store } from '../store/index.js';
import type { TenantSummary } from '@runforge/contracts';

export const systemApi = Router();

systemApi.get('/tenants', async (_req, res) => {
  const rows = await store.listTenants();
  const tenants: TenantSummary[] = rows.map((t) => ({ id: t.id, name: t.name, status: t.status, createdAt: t.created_at }));
  res.json({ tenants });
});
