import type { ApiTokenSummary, TenantUserSummary } from '@runforge/contracts';
import type { AuthTokenRow, UserRow } from '../store/types.js';

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
