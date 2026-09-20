import {
  abortRunExecution,
  abortThreadExecutions,
  waitForRunExecution,
} from '../agent/executionControl.js';
import { releaseRunLeases } from '../datasources/accountPool.js';
import { shellManager } from '../shell/manager.js';
import { store } from '../store/index.js';
import type { ThreadRow } from '../store/types.js';

/** 删除资源前停止当前进程中的模型请求与 Shell，并等待 executor 完成资源释放。 */
export async function stopThreadsForDeletion(threads: readonly ThreadRow[]): Promise<void> {
  if (!threads.length) return;
  const threadIds = threads.map((thread) => thread.id);
  const threadIdSet = new Set(threadIds);
  const runs = await store.cancelRunsForDeletion(threadIds);
  for (const run of runs) {
    abortRunExecution(run.id, '所属资源已删除，运行已取消。');
  }
  const activeRunIds = abortThreadExecutions(threadIdSet);

  await shellManager.killThreadCommands(threadIdSet, 'resource_deleted');
  await store.cancelShellCommandsForDeletion(threadIds);
  const runIds = new Set([...runs.map((run) => run.id), ...activeRunIds]);
  await Promise.all([...runIds].map(async (runId) => {
    await waitForRunExecution(runId);
    await releaseRunLeases(runId).catch((error) => {
      console.error(`[deletion] run ${runId} 的运行资源释放失败，需手动检查：${(error as Error).message}`);
    });
  }));
}
