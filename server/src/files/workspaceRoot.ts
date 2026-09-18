import { join, resolve } from 'node:path';
import { access, mkdir, rename } from 'node:fs/promises';
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
  return resolve(join(base, 'tenants', safeSegment(tenantId)));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 把旧固定 tenant ID 使用过的用户目录移入新 tenant ID 对应的统一目录。 */
export async function migrateLegacyBootstrapWorkspace(tenantId: string, base: string = config.tools.workspaceRoot): Promise<void> {
  const source = resolve(join(base, 'users'));
  if (!await pathExists(source)) return;
  const target = tenantBaseRoot(tenantId, base);
  const destination = join(target, 'users');
  if (await pathExists(destination)) {
    throw new Error(`bootstrap tenant workspace 迁移目标已存在：${destination}`);
  }
  await mkdir(target, { recursive: true });
  await rename(source, destination);
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

/** 非默认空间按全局唯一 thread ID 使用短路径，不重复 tenant/space/user 层级。 */
export function resolveThreadWorkspaceRoot(threadId: string, base: string = config.tools.workspaceRoot): string {
  return resolve(join(base, safeSegment(threadId)));
}

/** 默认空间使用用户级 workspace；其他空间统一使用 thread 短路径。
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
