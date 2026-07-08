import { executeRun } from './executor.js';
import type { Store } from '../store/types.js';
import { store as defaultStore } from '../store/index.js';
import { runBus } from './bus.js';

/** 服务启动恢复异常中断的 run；等待用户回答的 run 必须继续等待。 */
export async function recoverInterruptedRuns(store: Store = defaultStore): Promise<number> {
  const runs = await store.listRunsByStatus(['pending', 'running', 'canceling']);
  let started = 0;
  for (const run of runs) {
    if (run.status === 'canceling') {
      await store.setRunStatus(run.id, 'canceled');
      await store.addEvent(run.id, null, { type: 'error', step: 0, message: '服务恢复期间，run 已被取消。' });
      continue;
    }
    const lastStep = await store.getLastStepIndex(run.id);
    const lastCompletedStep = await store.getLastCompletedStepIndex(run.id);
    const message = lastStep > lastCompletedStep
      ? `服务已重启，正在从第 ${lastCompletedStep} 个完整 step 后继续；未完整落库的 step 只保留为事件审计，不进入模型上下文。`
      : '服务已重启，正在从最近的持久化检查点恢复 run。';
    await store.addEvent(run.id, null, {
      type: 'recovery',
      step: lastStep + 1,
      message,
    });
    runBus.publish(run.id, {
      type: 'recovery',
      step: lastStep + 1,
      message,
    });
    void executeRun(run.id, { resume: true });
    started += 1;
  }
  return started;
}
