import assert from 'node:assert/strict';
import { test } from 'node:test';

test('关闭开始后，启动恢复不会接纳或改变待恢复 run', async () => {
  process.env.STORE = 'memory';
  const [{ MemoryStore }, { recoverInterruptedRuns }, executionControl] = await Promise.all([
    import('../store/memoryStore.js'),
    import('./recovery.js'),
    import('./executionControl.js'),
  ]);

  const store = new MemoryStore();
  const scope = { tenantId: 'recovery-shutdown-test', userId: 'owner' };
  const thread = await store.createThread(scope, 'Recovery shutdown test');
  const run = await store.createRun(scope, thread.id, 'Pending recovery fixture');

  // 首次持久层扫描会让出执行权；同一轮同步调用期间开始关闭，恢复循环随后必须退出。
  const recovery = recoverInterruptedRuns(store);
  executionControl.stopAcceptingNewRunExecutions();

  assert.equal(await recovery, 0);
  assert.equal((await store.getRun(scope, run.id))?.status, 'pending');
});
