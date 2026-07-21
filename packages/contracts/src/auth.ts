export type TenantUserRole = 'owner' | 'admin' | 'member';

export interface TenantUserSummary {
  id: string;
  tenantId: string;
  email: string;
  role: TenantUserRole;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface ApiTokenSummary {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface LoginRequest {
  email: string;
  password: string;
  tenantId?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: TenantUserSummary;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
}

export interface SystemLoginRequest {
  email: string;
  password: string;
}

export interface SystemLoginResponse {
  accessToken: string;
  refreshToken: string;
}

export interface CreateUserInput {
  email: string;
  password: string;
  role?: TenantUserRole;
}

export interface UpdateUserInput {
  role?: TenantUserRole;
  status?: 'active' | 'disabled';
}

export interface CreateApiTokenInput {
  label?: string;
}

export interface CreateApiTokenResponse extends ApiTokenSummary {
  token: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: string;
}

export interface CreateTenantInput {
  id: string;
  name: string;
  ownerEmail: string;
  ownerPassword: string;
}

export interface CreateTenantResponse {
  tenant: TenantSummary;
  owner: TenantUserSummary;
}

export interface UpdateTenantStatusInput {
  status: 'active' | 'suspended';
}

export interface SystemAdminSummary {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface CreateSystemAdminInput {
  email: string;
  password: string;
}
