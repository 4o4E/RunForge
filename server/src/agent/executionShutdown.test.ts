import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from './executor.js';
import { stopAcceptingNewRunExecutions, waitForAllRunExecutions } from './executionControl.js';
import { MemoryStore } from '../store/memoryStore.js';
import { normalizeToolSettings } from '../settings.js';
import type { AgentEvent } from './types.js';
import type { Scope } from '../store/types.js';

// 关闭开关不可重置；独立测试文件由 node:test 放在独立进程，避免影响其他 executor 消费者。
test('shutdown interrupts subagent terminal waiting, pairs tool results, and preserves resumable run status', { timeout: 5000 }, async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-wait-shutdown-'));
  const store = new MemoryStore();
  const scope: Scope = { tenantId: 'default', userId: 'us_shutdown_test' };
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '等待子任务时正常停机');
  const events: AgentEvent[] = [];
  let turns = 0;
  let childSignal: AbortSignal | undefined;
  let resolvePollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => { resolvePollStarted = resolve; });
  const executing = executeRun(run.id, {
    store,
    provider: {
      name: 'shutdown-wait-consumer',
      async completeStream(messages, _tools, _delta, options) {
        const prompt = messages.map((message) => message.content ?? '').join('\n');
        if (prompt.includes('异步只读推理型 subagent')) {
          childSignal = options?.abortSignal;
          assert.ok(childSignal);
          childSignal.throwIfAborted();
          await new Promise<void>((_resolve, reject) => {
            const signal = childSignal!;
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
          throw new Error('关闭后的子任务不应继续执行');
        }
        turns += 1;
        if (turns === 1) return { content: null, toolCalls: [{ id: 'start', name: 'subagent_run', arguments: '{"task":"等待服务关闭"}' }] };
        const subagentRunId = prompt.match(/subagentRunId: (sr_[A-Za-z0-9]+)/)?.[1];
        return { content: null, toolCalls: [
          { id: 'poll_shutdown', name: 'subagent_poll', arguments: JSON.stringify({ subagentRunId }) },
          { id: 'unexecuted_shutdown', name: 'subagent_list', arguments: '{}' },
        ] };
      },
    },
    publish: (_id, event) => {
      events.push(event);
      if (event.type === 'tool_call' && event.id === 'poll_shutdown') resolvePollStarted();
    },
    hardStepCap: 4,
    toolSettings: normalizeToolSettings({ workspaceRoot, sandbox: 'off', shellUseHostPath: true }),
  });
  try {
    await pollStarted;
    stopAcceptingNewRunExecutions();
    await executing;
    await waitForAllRunExecutions();
    assert.equal(turns, 2, '等待或关闭不得进入新的 provider 轮次');
    assert.equal((await store.getRun(scope, run.id))?.status, 'running', '正常关闭不是用户取消，也不是普通工具错误');
    const [child] = await store.listSubagentRunsByThread(scope, thread.id);
    assert.equal(child.status, 'running', '关闭期间保留实际中断状态，下次恢复明确报告孤儿');
    const messages = await store.loadThreadMessages(scope, thread.id);
    for (const id of ['poll_shutdown', 'unexecuted_shutdown']) {
      const results = messages.filter((message) => message.role === 'tool' && message.toolCallId === id);
      assert.equal(results.length, 1);
      assert.match(results[0].content ?? '', /服务关闭.*中断/);
      assert.equal(events.filter((event) => event.type === 'tool_result' && event.id === id).length, 1);
    }
    assert.equal(await store.getLastCompletedStepIndex(scope, run.id), 2);
    assert.ok(childSignal?.aborted);
    assert.equal(getEventListeners(childSignal!, 'abort').length, 0);
  } finally {
    stopAcceptingNewRunExecutions();
    await executing;
    await waitForAllRunExecutions();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
