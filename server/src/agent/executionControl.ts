interface ActiveRunExecution {
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  threadId: string | null;
  holders: number;
  mainActive: boolean;
}

const activeExecutions = new Map<string, ActiveRunExecution>();

export interface RunExecutionRegistration {
  signal: AbortSignal;
  bindThread(threadId: string): void;
  finish(): void;
}

function registration(
  runId: string,
  entry: ActiveRunExecution,
  main: boolean,
): RunExecutionRegistration {
  if (main) {
    if (entry.mainActive) throw new Error(`run ${runId} 已有活动 executor`);
    if (entry.controller.signal.aborted) throw new Error(`run ${runId} 已经取消`);
    entry.mainActive = true;
  }
  entry.holders += 1;
  let finished = false;
  return {
    signal: entry.controller.signal,
    bindThread: (threadId) => {
      if (entry.threadId && entry.threadId !== threadId) {
        throw new Error(`run ${runId} 不能同时绑定到 thread ${entry.threadId} 和 ${threadId}`);
      }
      entry.threadId = threadId;
    },
    finish: () => {
      if (finished) return;
      finished = true;
      if (main) entry.mainActive = false;
      entry.holders -= 1;
      if (entry.holders > 0 || activeExecutions.get(runId) !== entry) return;
      activeExecutions.delete(runId);
      entry.resolveDone();
    },
  };
}

/** 注册当前进程中的 executor，供取消或资源永久删除时立即中止并等待资源释放。 */
export function registerRunExecution(runId: string): RunExecutionRegistration {
  const existing = activeExecutions.get(runId);
  if (existing) return registration(runId, existing, true);
  const controller = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const entry = { controller, done, resolveDone, threadId: null, holders: 0, mainActive: false };
  activeExecutions.set(runId, entry);
  return registration(runId, entry, true);
}

/** 后台子任务持有同一个 run 的取消信号，并让删除流程等待它完成。 */
export function retainRunExecution(runId: string): RunExecutionRegistration {
  const entry = activeExecutions.get(runId);
  if (!entry) throw new Error(`run ${runId} 没有活动 executor`);
  return registration(runId, entry, false);
}

export function abortRunExecution(runId: string, reason = '用户已取消 run。'): boolean {
  const entry = activeExecutions.get(runId);
  if (!entry) return false;
  entry.controller.abort(new Error(reason));
  return true;
}

export function abortThreadExecutions(
  threadIds: ReadonlySet<string>,
  reason = '所属资源已删除，运行已取消。',
): string[] {
  const runIds: string[] = [];
  for (const [runId, entry] of activeExecutions) {
    if (!entry.threadId || !threadIds.has(entry.threadId)) continue;
    entry.controller.abort(new Error(reason));
    runIds.push(runId);
  }
  return runIds;
}

export async function waitForRunExecution(runId: string): Promise<void> {
  await activeExecutions.get(runId)?.done;
}
