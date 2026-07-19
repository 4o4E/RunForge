import { executeRun } from './executor.js';
import { scopeForThread, type Scope, type Store } from '../store/types.js';
import { store as defaultStore } from '../store/index.js';
import { runBus } from './bus.js';

/** 服务启动恢复异常中断的 run；等待用户回答的 run 必须继续等待。
 *  启动期扫描本身就要跨租户(listRunsByStatusUnscoped)，每个 run 单独从
 *  其 thread 反推 scope 再继续(docs/multi-tenancy-design.md §7)。 */
export async function recoverInterruptedRuns(store: Store = defaultStore): Promise<number> {
  const runs = await store.listRunsByStatusUnscoped(['pending', 'running', 'canceling']);
  let started = 0;
  for (const run of runs) {
    const thread = await store.getThreadUnscoped(run.thread_id);
    if (!thread) continue;
    let scope: Scope;
    try {
      scope = scopeForThread(thread);
    } catch (err) {
      // thread 的 user_id 为空(用户已被删除):按设计这类 thread 对所有人都不可查,
      // 恢复也无法确定该用什么身份继续,跳过这一个 run,不阻塞其它 run 的恢复。
      console.warn(`recovery skipped run ${run.id}: ${(err as Error).message}`);
      continue;
    }
    if (run.status === 'canceling') {
      await store.setRunStatus(scope, run.id, 'canceled');
      await store.addEvent(scope, run.id, null, { type: 'error', step: 0, message: '服务恢复期间，run 已被取消。' });
      continue;
    }
    const lastStep = await store.getLastStepIndex(scope, run.id);
    const lastCompletedStep = await store.getLastCompletedStepIndex(scope, run.id);
    const message = lastStep > lastCompletedStep
      ? `服务已重启，正在从第 ${lastCompletedStep} 个完整 step 后继续；未完整落库的 step 只保留为事件审计，不进入模型上下文。`
      : '服务已重启，正在从最近的持久化检查点恢复 run。';
    await store.addEvent(scope, run.id, null, {
      type: 'recovery',
      step: lastStep + 1,
      message,
    });
    runBus.publish(run.id, {
      type: 'recovery',
      step: lastStep + 1,
      message,
    });
    void executeRun(run.id, { resume: true, scope });
    started += 1;
  }
  return started;
}
