import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { scopeForThread, type TenantRow, type ThreadRow } from '../store/types.js';

export interface WorkspaceScope {
  tenantId: string;
  userId?: string | null;
}

function safeSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]/g, '-');
}

function tenantBaseRoot(tenantId: string, base: string): string {
  if (tenantId === 'default') return resolve(base);
  return resolve(join(base, 'tenants', safeSegment(tenantId)));
}

/** 按租户+用户派生 workspace 根目录。
 *  旧逻辑只按 tenant 分目录,同租户用户会共享文件树；现在每个用户落在自己的
 *  `<tenantBase>/users/<userId>/workspace` 下。调用方没有 userId 时只返回租户
 *  基础目录,用于启动日志等不代表具体用户的场景,不能作为工具执行目录。 */
export function resolveWorkspaceRoot(scope: WorkspaceScope | string, base: string = config.tools.workspaceRoot): string {
  const tenantId = typeof scope === 'string' ? scope : scope.tenantId;
  const userId = typeof scope === 'string' ? null : scope.userId;
  const tenantRoot = tenantBaseRoot(tenantId, base);
  if (!userId) return tenantRoot;
  return resolve(join(tenantRoot, 'users', safeSegment(userId), 'workspace'));
}

/** 非 default 空间按全局唯一 thread ID 使用短路径，不重复 tenant/space/user 层级。 */
export function resolveThreadWorkspaceRoot(threadId: string, base: string = config.tools.workspaceRoot): string {
  return resolve(join(base, safeSegment(threadId)));
}

/** default 空间沿用历史用户级 workspace；其他空间统一使用 thread 短路径。
 * thread 创建后 space/user 均不可迁移，因此这个映射在整个 thread 生命周期内稳定。 */
export function resolveWorkspaceRootForThread(
  thread: ThreadRow,
  tenant: Pick<TenantRow, 'default_space_id'>,
  base: string = config.tools.workspaceRoot,
): { kind: 'user' | 'thread'; root: string } {
  if (thread.space_id === tenant.default_space_id) {
    return { kind: 'user', root: resolveWorkspaceRoot(scopeForThread(thread), base) };
  }
  return { kind: 'thread', root: resolveThreadWorkspaceRoot(thread.id, base) };
}
