import type {
  CreateSystemAdminInput,
  CreateTenantInput,
  CreateTenantResponse,
  SystemAdminSummary,
  TenantSummary,
} from '@runforge/contracts';
import { createAuthSession } from './lib/authSession.js';

// 系统管理员是完全独立的身份体系(不同 JWT scope、不同 token 存储)，和 web/src/api.ts
// 里的租户会话互不干扰，可以在同一浏览器不同标签页同时保持登录。

const session = createAuthSession({
  refreshPath: '/api/system/auth/refresh',
  logoutPath: '/api/system/auth/logout',
  storageKey: 'runforge.sysAdmin.refreshToken',
  invalidEventName: 'runforge:sysadmin-access-token-invalid',
});

export const readSysAdminAccessToken = session.readAccessToken;
export const clearSysAdminAccessToken = session.clearAccessToken;
export const onSysAdminAccessTokenInvalid = session.onAccessTokenInvalid;
export const sysAdminRestoreSession = session.restoreSession;
export const sysAdminLogout = session.logout;
export const sysAdminAuthFetch = session.authFetch;

export async function sysAdminLogin(email: string, password: string): Promise<void> {
  const res = await globalThis.fetch('/api/system/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string };
  session.applyLoginTokens(body);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { error?: unknown };
      detail = typeof body.error === 'string' ? body.error : '';
    } catch {
      detail = '';
    }
    throw new Error(detail ? `${res.status} ${detail}` : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const listSystemTenants = () =>
  sysAdminAuthFetch('/api/system/tenants').then(json<{ tenants: TenantSummary[] }>);

export const createSystemTenant = (input: CreateTenantInput) =>
  sysAdminAuthFetch('/api/system/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<CreateTenantResponse>);

export const updateSystemTenantStatus = (id: string, status: 'active' | 'suspended') =>
  sysAdminAuthFetch(`/api/system/tenants/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }).then(json<{ tenant: TenantSummary }>);

export const listSystemAdminAccounts = () =>
  sysAdminAuthFetch('/api/system/admins').then(json<{ admins: SystemAdminSummary[] }>);

export const createSystemAdminAccount = (input: CreateSystemAdminInput) =>
  sysAdminAuthFetch('/api/system/admins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<SystemAdminSummary>);
