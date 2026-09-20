import { DeleteConflictError } from '../store/types.js';

export interface DeletionScope {
  tenantId: string;
  spaceId?: string;
  threadId?: string;
}

interface ActiveDeletion {
  tenantId: string;
  spaceIds: Set<string>;
  threadIds: Set<string>;
}

interface ActiveOperation {
  scope: DeletionScope;
  done: Promise<void>;
  resolveDone: () => void;
}

export interface DeletionRegistration {
  addThreads(threadIds: Iterable<string>): void;
  waitForOperations(): Promise<void>;
  finish(): void;
}

interface DeletionOperation {
  finish(): void;
}

class DeletionGate {
  private readonly active = new Set<ActiveDeletion>();
  private readonly operations = new Set<ActiveOperation>();

  begin(scope: DeletionScope): DeletionRegistration {
    if (this.isBlocked(scope)) {
      throw new DeleteConflictError('RESOURCE_DELETION_IN_PROGRESS', '资源正在删除');
    }
    const deletion: ActiveDeletion = {
      tenantId: scope.tenantId,
      spaceIds: new Set(scope.spaceId ? [scope.spaceId] : []),
      threadIds: new Set(scope.threadId ? [scope.threadId] : []),
    };
    this.active.add(deletion);
    return {
      addThreads: (threadIds) => {
        for (const threadId of threadIds) deletion.threadIds.add(threadId);
      },
      waitForOperations: async () => {
        const pending = [...this.operations]
          .filter((operation) => this.blocks(deletion, operation.scope))
          .map((operation) => operation.done);
        await Promise.all(pending);
      },
      finish: () => this.active.delete(deletion),
    };
  }

  /** 删除开始前已接纳的短事务先完成；删除登记后同范围的新事务会立即拒绝。 */
  enter(scope: DeletionScope): DeletionOperation {
    if (this.isBlocked(scope)) {
      throw new DeleteConflictError('RESOURCE_DELETION_IN_PROGRESS', '资源正在删除');
    }
    let resolveDone!: () => void;
    const operation: ActiveOperation = {
      scope,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      resolveDone,
    };
    this.operations.add(operation);
    let finished = false;
    return {
      finish: () => {
        if (finished) return;
        finished = true;
        this.operations.delete(operation);
        operation.resolveDone();
      },
    };
  }

  private isBlocked(scope: DeletionScope): boolean {
    for (const deletion of this.active) {
      if (this.blocks(deletion, scope)) return true;
    }
    return false;
  }

  private blocks(deletion: ActiveDeletion, scope: DeletionScope): boolean {
    if (deletion.tenantId !== scope.tenantId) return false;
    if (!scope.spaceId && !scope.threadId) return true;
    if (!deletion.spaceIds.size && !deletion.threadIds.size) return true;
    if (scope.spaceId && deletion.spaceIds.has(scope.spaceId)) return true;
    return Boolean(scope.threadId && deletion.threadIds.has(scope.threadId));
  }
}

export const deletionGate = new DeletionGate();
