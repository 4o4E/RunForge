import type { IdentityContext } from '../auth/context.js';
import {
  spaceAccess as defaultSpaceAccess,
  SpaceAccessError,
  type SpaceAccessService,
} from '../spaces/access.js';
import { store as defaultStore } from '../store/index.js';
import type { Store, ThreadRow } from '../store/types.js';
import { getSystemToolSettings as readSystemToolSettings } from '../settings.js';
import type { ToolSettings } from '@runforge/contracts';
import { ensureThreadWorkspaceRoot, resolveWorkspaceRootForThread } from './workspaceRoot.js';
import { deletionGate } from '../deletion/gate.js';

type TenantIdentity = Extract<IdentityContext, { scope: 'tenant' }>;

export class ThreadWorkspaceAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ThreadWorkspaceAccessError';
  }
}

export interface ThreadWorkspaceResolution {
  root: string;
  threadId: string;
  spaceId: string;
}

export class ThreadWorkspaceAccessService {
  constructor(
    private readonly store: Store = defaultStore,
    private readonly spaces: SpaceAccessService = defaultSpaceAccess,
    private readonly getSystemToolSettings: () => Promise<Pick<ToolSettings, 'workspaceRoot'>> = readSystemToolSettings,
  ) {}

  /** Web 文件入口的授权规则：
   * - 文件入口必须绑定 thread，工作目录固定为 `{base}/{spaceId}/{threadId}`；
   * - Web 空间的 thread 仍只属于创建用户；空间可见不等于能查看其他用户的对话文件；
   * - external 空间允许可见用户只读，写入和 shell 始终拒绝。 */
  async resolveForWeb(
    identity: TenantIdentity,
    threadId: string | null,
    access: 'read' | 'write',
  ): Promise<ThreadWorkspaceResolution> {
    if (!threadId) {
      throw new ThreadWorkspaceAccessError(409, 'THREAD_REQUIRED', '文件工作区需要先创建会话');
    }

    const operation = deletionGate.enter({ tenantId: identity.tenantId, threadId });
    try {
      return await this.resolveForWebAccepted(identity, threadId, access);
    } finally {
      operation.finish();
    }
  }

  private async resolveForWebAccepted(
    identity: TenantIdentity,
    threadId: string,
    access: 'read' | 'write',
  ): Promise<ThreadWorkspaceResolution> {

    let thread = await this.store.getThread(
      { tenantId: identity.tenantId, userId: identity.userId },
      threadId,
    );
    let space: Awaited<ReturnType<SpaceAccessService['get']>>;
    if (thread) {
      space = await this.authorizeSpace(() => this.spaces.get(identity, thread!.space_id));
    } else {
      // external thread 的查看者不是 execution user；按可见空间查询后才能区分
      // “确实不可见”和“可见但 Web 只读”。Web thread 仍会在下面复核创建用户。
      const visibleSpaces = await this.authorizeSpace(() => this.spaces.list(identity));
      thread = await this.store.getThreadInSpaces(
        identity.tenantId,
        threadId,
        visibleSpaces.map((item) => item.id),
      );
      if (!thread) throw new ThreadWorkspaceAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
      const visibleSpace = visibleSpaces.find((item) => item.id === thread!.space_id);
      if (!visibleSpace) throw new ThreadWorkspaceAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
      space = visibleSpace;
    }

    if (space.mode === 'web' && thread.user_id !== identity.userId) {
      throw new ThreadWorkspaceAccessError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
    }
    if (access === 'write') {
      if (space.mode !== 'web') {
        throw new ThreadWorkspaceAccessError(403, 'SPACE_READ_ONLY', '外部空间在 Web 中只读');
      }
      await this.authorizeSpace(() => this.spaces.requireWritableWebSpace(identity, space.id));
    }
    return this.resolveThread(thread);
  }

  private async resolveThread(thread: ThreadRow): Promise<ThreadWorkspaceResolution> {
    const { workspaceRoot } = await this.getSystemToolSettings();
    const resolved = resolveWorkspaceRootForThread(thread, workspaceRoot);
    await ensureThreadWorkspaceRoot(thread.space_id, thread.id, workspaceRoot);
    return {
      ...resolved,
      threadId: thread.id,
      spaceId: thread.space_id,
    };
  }

  private async authorizeSpace<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SpaceAccessError) {
        throw new ThreadWorkspaceAccessError(error.status, error.code, error.message);
      }
      throw error;
    }
  }
}

export const threadWorkspaceAccess = new ThreadWorkspaceAccessService();
