import type { CreateUserInput, TenantUserSummary, UpdateUserInput } from '@runforge/contracts';
import { createTenantUser, deleteTenantUser, listTenantUsers, updateTenantUser } from './api.js';
import { createSystemTenantUser, deleteSystemTenantUser, listSystemTenantUsers, updateSystemTenantUser } from './sysAdminApi.js';

export interface TenantUsersControlApi {
  list(): Promise<{ users: TenantUserSummary[] }>;
  create(input: CreateUserInput): Promise<TenantUserSummary>;
  update(userId: string, input: UpdateUserInput): Promise<TenantUserSummary>;
  delete(userId: string): Promise<void>;
}

export function createTenantUsersControlApi(tenantId: string): TenantUsersControlApi {
  return {
    list: () => listTenantUsers(tenantId),
    create: (input) => createTenantUser(tenantId, input),
    update: (userId, input) => updateTenantUser(tenantId, userId, input),
    delete: (userId) => deleteTenantUser(tenantId, userId),
  };
}

export function createSystemTenantUsersControlApi(tenantId: string): TenantUsersControlApi {
  return {
    list: () => listSystemTenantUsers(tenantId),
    create: (input) => createSystemTenantUser(tenantId, input),
    update: (userId, input) => updateSystemTenantUser(tenantId, userId, input),
    delete: (userId) => deleteSystemTenantUser(tenantId, userId),
  };
}
