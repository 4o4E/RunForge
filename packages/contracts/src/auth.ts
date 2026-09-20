export type TenantUserRole = 'owner' | 'admin' | 'member';

export interface TenantUserSummary {
  id: string;
  tenantId: string;
  email: string;
  role: TenantUserRole;
  status: 'active' | 'disabled';
  isDefaultAdmin: boolean;
  createdAt: string;
}

export interface CurrentTenantUserSummary extends TenantUserSummary {
  tenantName: string;
}

export interface LoginTenantSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface LoginTenantsResponse {
  tenants: LoginTenantSummary[];
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
  email?: string;
  password?: string;
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
  isDefault: boolean;
  createdAt: string;
}

export interface CreateTenantInput {
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
  isDefaultAdmin: boolean;
  createdAt: string;
}

export interface CreateSystemAdminInput {
  email: string;
  password: string;
}
