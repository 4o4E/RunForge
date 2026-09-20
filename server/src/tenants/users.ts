import type { CreateUserInput, TenantUserRole, UpdateUserInput } from '@runforge/contracts';
import { hashPassword } from '../auth/passwords.js';
import { removeUserWorkspace } from '../files/workspaceRoot.js';
import { store } from '../store/index.js';
import { DeleteConflictError, type UserRow } from '../store/types.js';

export type TenantUserActor =
  | { scope: 'system' }
  | { scope: 'tenant'; userId: string; role: TenantUserRole };

export class TenantUserError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isTenantUserRole(value: unknown): value is TenantUserRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

function isUserStatus(value: unknown): value is 'active' | 'disabled' {
  return value === 'active' || value === 'disabled';
}

export async function createTenantUser(
  tenantId: string,
  actor: TenantUserActor,
  input: Partial<CreateUserInput> | undefined,
): Promise<UserRow> {
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const password = typeof input?.password === 'string' ? input.password : '';
  const role = input?.role ?? 'member';
  if (!email || !password) throw new TenantUserError(400, '缺少 email 或 password');
  if (!isTenantUserRole(role)) throw new TenantUserError(400, 'role 必须是 owner / admin / member');

  if (actor.scope === 'tenant' && actor.role === 'member') {
    throw new TenantUserError(403, '需要 owner 或 admin 权限');
  }
  if (actor.scope === 'tenant' && actor.role === 'admin' && role !== 'member') {
    throw new TenantUserError(403, '只有 owner 能创建 admin 或 owner 账号');
  }

  if (await store.findUserByEmail(tenantId, email)) {
    throw new TenantUserError(409, '该邮箱在当前租户下已存在');
  }

  return store.createUser({ tenantId, email, passwordHash: hashPassword(password), role });
}

export async function updateTenantUser(
  tenantId: string,
  userId: string,
  actor: TenantUserActor,
  input: Partial<UpdateUserInput> | undefined,
): Promise<UserRow> {
  const email = typeof input?.email === 'string' ? input.email.trim() : undefined;
  const password = typeof input?.password === 'string' ? input.password : undefined;
  const role = input?.role;
  const status = input?.status;
  if (email === undefined && password === undefined && role === undefined && status === undefined) {
    throw new TenantUserError(400, '缺少可更新字段');
  }
  if (email !== undefined && !email) throw new TenantUserError(400, 'email 不能为空');
  if (password !== undefined && !password) throw new TenantUserError(400, 'password 不能为空');
  if (role !== undefined && !isTenantUserRole(role)) {
    throw new TenantUserError(400, 'role 必须是 owner / admin / member');
  }
  if (status !== undefined && !isUserStatus(status)) {
    throw new TenantUserError(400, 'status 必须是 active / disabled');
  }

  const target = await store.findUserById(userId);
  if (!target || target.tenant_id !== tenantId) throw new TenantUserError(404, '用户不存在');

  if (actor.scope === 'tenant') {
    if (actor.role === 'member') throw new TenantUserError(403, '需要 owner 或 admin 权限');
    if (target.id === actor.userId && (role !== undefined || status !== undefined)) {
      throw new TenantUserError(403, '不能修改自己的角色或状态');
    }
    if (actor.role === 'admin') {
      if (target.id !== actor.userId && target.role !== 'member') {
        throw new TenantUserError(403, 'admin 只能管理 member 账号');
      }
      if (role !== undefined && role !== 'member') {
        throw new TenantUserError(403, '只有 owner 能设置 admin 或 owner 角色');
      }
    }
  }

  if (email !== undefined && email !== target.email) {
    const existing = await store.findUserByEmail(tenantId, email);
    if (existing && existing.id !== target.id) {
      throw new TenantUserError(409, '该邮箱在当前租户下已存在');
    }
  }

  let updated: UserRow | null;
  try {
    updated = await store.updateUser(target.id, {
      email,
      passwordHash: password === undefined ? undefined : hashPassword(password),
      role,
      status,
    });
  } catch (error) {
    if (error instanceof DeleteConflictError) throw new TenantUserError(409, error.message);
    throw error;
  }
  if (!updated) throw new TenantUserError(404, '用户不存在');
  if (password !== undefined) await store.revokeRefreshTokensByUser(target.id);
  return updated;
}

export async function deleteTenantUser(
  tenantId: string,
  userId: string,
  actor: TenantUserActor,
): Promise<void> {
  const target = await store.findUserById(userId);
  if (!target || target.tenant_id !== tenantId) throw new TenantUserError(404, '用户不存在');

  if (actor.scope === 'tenant') {
    if (actor.role === 'member') throw new TenantUserError(403, '需要 owner 或 admin 权限');
    if (actor.role === 'admin' && target.role !== 'member') {
      throw new TenantUserError(403, 'admin 只能管理 member 账号');
    }
  }

  try {
    const deleted = await store.deleteUser(tenantId, userId);
    if (!deleted) throw new TenantUserError(404, '用户不存在');
  } catch (error) {
    if (error instanceof DeleteConflictError) throw new TenantUserError(409, error.message);
    throw error;
  }
  await removeUserWorkspace(tenantId, userId);
}
