import type {
  auth_tokens,
  runs,
  steps,
  system_admin_tokens,
  system_admins,
  tenants,
  thread_notices,
  threads,
  users,
} from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { GoalState } from '../agent/goal.js';
import type {
  AuthTokenRow,
  RunRow,
  StepRow,
  SystemAdminRow,
  SystemAdminTokenRow,
  TenantRow,
  ThreadNoticeRow,
  ThreadRow,
  UserRow,
} from './types.js';

export function timestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function serializedJson(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('值必须是可持久化的 JSON');
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

export function requiredJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : serializedJson(value);
}

export function nullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value == null ? Prisma.DbNull : serializedJson(value);
}

export function serialId(value: bigint): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`数据库序列 ID 超出 JavaScript 安全整数范围：${value}`);
  return id;
}

export function toThreadRow(row: threads, fallbackTitle?: string | null): ThreadRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    title: row.title,
    fallback_title: fallbackTitle,
    active_run_id: row.active_run_id,
    pinned_at: timestamp(row.pinned_at),
    archived_at: timestamp(row.archived_at),
    created_at: timestamp(row.created_at)!,
    updated_at: timestamp(row.updated_at)!,
  };
}

export function toRunRow(row: runs): RunRow {
  return {
    id: row.id,
    thread_id: row.thread_id,
    parent_run_id: row.parent_run_id,
    status: row.status as RunRow['status'],
    input: row.input,
    model_ref: row.model_ref,
    output: row.output,
    error: row.error,
    goal_state: row.goal_state as GoalState | null,
    runtime_capabilities_snapshot: row.runtime_capabilities_snapshot as Record<string, unknown> | null,
    created_at: timestamp(row.created_at)!,
    updated_at: timestamp(row.updated_at)!,
  };
}

export function toStepRow(row: steps): StepRow {
  return {
    id: row.id,
    run_id: row.run_id,
    idx: row.idx,
    created_at: timestamp(row.created_at)!,
  };
}

export function toThreadNoticeRow(row: thread_notices): ThreadNoticeRow {
  return {
    id: serialId(row.id),
    thread_id: row.thread_id,
    kind: row.kind,
    message: row.message,
    title: row.title,
    linked_thread_id: row.linked_thread_id,
    linked_run_id: row.linked_run_id,
    created_at: timestamp(row.created_at)!,
  };
}

export function toTenantRow(row: tenants): TenantRow {
  return {
    id: row.id,
    name: row.name,
    status: row.status as TenantRow['status'],
    created_at: timestamp(row.created_at)!,
  };
}

export function toUserRow(row: users): UserRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    email: row.email,
    password_hash: row.password_hash,
    role: row.role as UserRow['role'],
    status: row.status as UserRow['status'],
    created_at: timestamp(row.created_at)!,
  };
}

export function toAuthTokenRow(row: auth_tokens): AuthTokenRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    kind: row.kind as AuthTokenRow['kind'],
    token_hash: row.token_hash,
    label: row.label,
    expires_at: timestamp(row.expires_at),
    revoked_at: timestamp(row.revoked_at),
    created_at: timestamp(row.created_at)!,
  };
}

export function toSystemAdminRow(row: system_admins): SystemAdminRow {
  return {
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    status: row.status as SystemAdminRow['status'],
    created_at: timestamp(row.created_at)!,
  };
}

export function toSystemAdminTokenRow(row: system_admin_tokens): SystemAdminTokenRow {
  return {
    id: row.id,
    system_admin_id: row.system_admin_id,
    token_hash: row.token_hash,
    expires_at: timestamp(row.expires_at),
    revoked_at: timestamp(row.revoked_at),
    created_at: timestamp(row.created_at)!,
  };
}
