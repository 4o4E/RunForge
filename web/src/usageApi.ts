import type { UsageAggregateResponse } from '@runforge/contracts';
import { authFetch } from './api.js';
import { sysAdminAuthFetch } from './sysAdminApi.js';

export interface UsageQuery {
  rangeDays: number;
  tenantId?: string | null;
  userId?: string | null;
  spaceId?: string | null;
}

function usageParams(query: UsageQuery): URLSearchParams {
  const to = new Date();
  const from = new Date(to.getTime() - query.rangeDays * 24 * 60 * 60 * 1_000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (query.tenantId) params.set('tenantId', query.tenantId);
  if (query.userId) params.set('userId', query.userId);
  if (query.spaceId) params.set('spaceId', query.spaceId);
  return params;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === 'string' ? body.error : `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function getPersonalUsage(query: UsageQuery): Promise<UsageAggregateResponse> {
  return authFetch(`/api/usage/aggregate?${usageParams(query)}`).then(json<UsageAggregateResponse>);
}

export function getTenantUsage(query: UsageQuery): Promise<UsageAggregateResponse> {
  const params = usageParams(query);
  params.set('scope', 'tenant');
  return authFetch(`/api/usage/aggregate?${params}`).then(json<UsageAggregateResponse>);
}

export function getSystemUsage(query: UsageQuery): Promise<UsageAggregateResponse> {
  return sysAdminAuthFetch(`/api/system/usage/aggregate?${usageParams(query)}`).then(json<UsageAggregateResponse>);
}

export async function refreshSystemStorageUsage(): Promise<void> {
  await sysAdminAuthFetch('/api/system/usage/storage/refresh', { method: 'POST' }).then(json<{ capturedAt: string }>);
}
