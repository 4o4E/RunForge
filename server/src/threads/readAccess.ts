import type { IdentityContext } from '../auth/context.js';
import { spaceAccess as defaultSpaceAccess, type SpaceAccessService } from '../spaces/access.js';
import { store as defaultStore } from '../store/index.js';
import { scopeForThread, type Scope, type Store, type ThreadRow } from '../store/types.js';
import type { SpaceSummary } from '@runforge/contracts';

type TenantIdentity = Extract<IdentityContext, { scope: 'tenant' }>;

export class ThreadReadAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ThreadReadAccessError';
  }
}

export interface ThreadReadResolution {
  thread: ThreadRow;
  space: SpaceSummary;
  executionScope: Scope;
  readOnly: boolean;
}

/**
 * 统一解析 Web 会话查看权限。空间可见性只授予 external 会话的只读查看权，
 * 不会让用户看到同一 Web 空间中其他用户的会话。executionScope 只在授权完成后
 * 用于读取既有持久化数据，绝不能被写接口复用成查看者的执行身份。
 */
export class ThreadReadAccessService {
  constructor(
    private readonly store: Store = defaultStore,
    private readonly spaces: SpaceAccessService = defaultSpaceAccess,
  ) {}

  async resolve(
    identity: TenantIdentity,
    threadId: string,
    requestedSpaceId?: string | null,
  ): Promise<ThreadReadResolution> {
    const visibleSpaces = await this.spaces.list(identity);
    const allowedSpaces = requestedSpaceId
      ? visibleSpaces.filter((space) => space.id === requestedSpaceId)
      : visibleSpaces;
    if (!allowedSpaces.length) throw new ThreadReadAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');

    const thread = await this.store.getThreadInSpaces(
      identity.tenantId,
      threadId,
      allowedSpaces.map((space) => space.id),
    );
    if (!thread) throw new ThreadReadAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
    const space = allowedSpaces.find((item) => item.id === thread.space_id);
    if (!space) throw new ThreadReadAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');

    if (space.mode === 'web' && (thread.source_type !== 'web' || thread.user_id !== identity.userId)) {
      throw new ThreadReadAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
    }
    if (space.mode === 'external' && thread.source_type !== 'external') {
      throw new ThreadReadAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
    }

    try {
      return {
        thread,
        space,
        executionScope: scopeForThread(thread),
        readOnly: space.mode === 'external',
      };
    } catch {
      throw new ThreadReadAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
    }
  }
}

export const threadReadAccess = new ThreadReadAccessService();
