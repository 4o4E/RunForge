import type { ApiTokenSummary, SystemAdminSummary, TenantSummary, TenantUserSummary } from '@runforge/contracts';
import type { AuthTokenRow, SystemAdminRow, TenantRow, UserRow } from '../store/types.js';

export function toUserSummary(user: UserRow): TenantUserSummary {
  return {
    id: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
  };
}

export function toApiTokenSummary(token: AuthTokenRow): ApiTokenSummary {
  return {
    id: token.id,
    label: token.label,
    createdAt: token.created_at,
    expiresAt: token.expires_at,
    revokedAt: token.revoked_at,
  };
}

export function toTenantSummary(tenant: TenantRow): TenantSummary {
  return {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    createdAt: tenant.created_at,
  };
}

export function toSystemAdminSummary(admin: SystemAdminRow): SystemAdminSummary {
  return {
    id: admin.id,
    email: admin.email,
    status: admin.status,
    createdAt: admin.created_at,
  };
}
