import { join, resolve } from 'node:path';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { config } from '../config.js';
import type { ThreadRow } from '../store/types.js';

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

/** 每个 thread 使用空间隔离的固定工作目录。space/thread ID 均由服务端生成且不可修改。 */
export function resolveThreadWorkspaceRoot(
  spaceId: string,
  threadId: string,
  base: string = config.tools.workspaceRoot,
): string {
  return resolve(join(base, safeSegment(spaceId), safeSegment(threadId)));
}

async function removeWorkspace(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    console.error(`[deletion] 目录删除失败，需手动处理：${target}：${(error as Error).message}`);
  }
}

export function removeThreadWorkspace(
  spaceId: string,
  threadId: string,
  base: string = config.tools.workspaceRoot,
): Promise<void> {
  return removeWorkspace(resolveThreadWorkspaceRoot(spaceId, threadId, base));
}

export function removeSpaceWorkspace(
  spaceId: string,
  base: string = config.tools.workspaceRoot,
): Promise<void> {
  return removeWorkspace(resolve(join(base, safeSegment(spaceId))));
}

export function removeUserWorkspace(
  tenantId: string,
  userId: string,
  base: string = config.tools.workspaceRoot,
): Promise<void> {
  return removeWorkspace(resolve(join(tenantBaseRoot(tenantId, base), 'users', safeSegment(userId))));
}

export function removeTenantWorkspace(
  tenantId: string,
  base: string = config.tools.workspaceRoot,
): Promise<void> {
  return removeWorkspace(tenantBaseRoot(tenantId, base));
}

/** 把旧版 `<base>/<threadId>` 工作目录原子移动到空间目录下；已迁移时可重复调用。 */
export async function ensureThreadWorkspaceRoot(
  spaceId: string,
  threadId: string,
  base: string = config.tools.workspaceRoot,
): Promise<string> {
  const target = resolveThreadWorkspaceRoot(spaceId, threadId, base);
  if (await pathExists(target)) return target;
  const legacy = resolve(join(base, safeSegment(threadId)));
  await mkdir(resolve(target, '..'), { recursive: true });
  if (await pathExists(legacy)) {
    try {
      await rename(legacy, target);
      return target;
    } catch (error) {
      if (!await pathExists(target)) throw error;
    }
  }
  await mkdir(target, { recursive: true });
  return target;
}

/** 所有空间统一按 `/w/{spaceId}/{threadId}` 派生工作目录。
 * thread 创建后 space 不可迁移，因此这个映射在整个 thread 生命周期内稳定。 */
export function resolveWorkspaceRootForThread(
  thread: ThreadRow,
  base: string = config.tools.workspaceRoot,
): { root: string } {
  return { root: resolveThreadWorkspaceRoot(thread.space_id, thread.id, base) };
}
