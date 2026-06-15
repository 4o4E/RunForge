import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReportGoal, finishGoal, initGoal, mergeGoal, parseGoalPatch, renderGoal, reportBlockedMessage } from './goal.js';
import { executeRun } from './executor.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { Provider } from '../llm/types.js';

test('mergeGoal: plan/next replace, decisions append, missing unfinished items become failed', () => {
  const g0 = initGoal('build the thing');
  const g1 = mergeGoal(g0, { plan: [{ text: 'a', status: 'doing' }, { text: 'b', status: 'doing' }], decisions: ['d1'], next: 'do a' });
  const g2 = mergeGoal(g1, { plan: [{ text: 'a', status: 'done' }], decisions: ['d2'], next: 'do b' });

  assert.equal(g2.intent, 'build the thing'); // 原始目标不变
  assert.deepEqual(g2.plan, [{ text: 'a', status: 'done' }, { text: 'b', status: 'failed' }]); // 漏掉的未完成项会保留为失败
  assert.deepEqual(g2.decisions, ['d1', 'd2']); // 决策只追加，不丢失
  assert.equal(g2.next, 'do b');
});

test('renderGoal: compact, includes intent + plan checkboxes + next', () => {
  const text = renderGoal({
    intent: 'X',
    phase: 'working',
    plan: [{ text: 'one', status: 'done' }, { text: 'two', status: 'todo' }, { text: 'three', status: 'failed' }],
    decisions: ['keep Y'],
    next: 'do two',
  });
  assert.match(text, /意图：X/);
  assert.match(text, /阶段：working/);
  assert.match(text, /\[x\] one/);
  assert.match(text, /\[ \] two/);
  assert.match(text, /\[!\] three/);
  assert.match(text, /keep Y/);
  assert.match(text, /下一步：do two/);
});

test('parseGoalPatch: coerces messy args, drops invalid', () => {
  const patch = parseGoalPatch({
    phase: 'reporting',
    plan: [{ text: 'a', status: 'failed' }, { text: '', status: 'todo' }, { status: 'bad' }],
    decisions: ['d1', ''],
    next: 'go',
  });
  assert.equal(patch.phase, 'reporting');
  assert.deepEqual(patch.plan, [{ text: 'a', status: 'failed' }]); // 空项和无效项会丢弃
  assert.deepEqual(patch.decisions, ['d1']);
  assert.equal(patch.next, 'go');
});

test('finishGoal: preserves terminal plan status instead of forcing success', () => {
  const goal = finishGoal({
    intent: 'ship it',
    phase: 'reporting',
    plan: [{ text: 'build', status: 'done' }, { text: 'verify', status: 'failed' }],
    decisions: ['keep tests'],
    next: 'verify',
  });

  assert.deepEqual(goal.plan.map((p) => p.status), ['done', 'failed']);
  assert.equal(goal.phase, 'completed');
  assert.equal(goal.next, '已结束（存在失败项）');
  assert.deepEqual(goal.decisions, ['keep tests']);
});

test('canReportGoal: plan tasks must settle and enter reporting phase', () => {
  const open = { intent: 'x', phase: 'working' as const, plan: [{ text: 'a', status: 'doing' as const }], decisions: [], next: '' };
  const settledWorking = { intent: 'x', phase: 'working' as const, plan: [{ text: 'a', status: 'failed' as const }], decisions: [], next: '' };
  const settledReporting = { ...settledWorking, phase: 'reporting' as const };
  const settledCompleted = { ...settledWorking, phase: 'completed' as const };
  assert.equal(canReportGoal(open), false);
  assert.match(reportBlockedMessage(open), /未收口/);
  assert.equal(canReportGoal(settledWorking), false);
  assert.match(reportBlockedMessage(settledWorking), /reporting/);
  assert.equal(canReportGoal(settledReporting), true);
  assert.equal(canReportGoal(settledCompleted), true);
  assert.equal(canReportGoal({ intent: 'x', phase: 'working' as const, plan: [], decisions: [], next: '' }), true);
});

test('executeRun: update_plan persists the goal anchor on the run', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'analyze the project');

  let turn = 0;
  const provider: Provider = {
    name: 'scripted',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{
            id: 'p1',
            name: 'update_plan',
            arguments: JSON.stringify({
              plan: [{ text: 'read files', status: 'doing' }],
              decisions: ['focus on server/'],
              next: 'read executor.ts',
            }),
          }],
        };
      }
      if (turn === 2) {
        return {
          content: 'done',
          toolCalls: [
            {
              id: 'p2',
              name: 'update_plan',
              arguments: JSON.stringify({
                plan: [{ text: 'read files', status: 'done' }],
                phase: 'reporting',
                next: '汇报结果',
              }),
            },
          ],
        };
      }
      return { content: 'done', toolCalls: [] };
    },
  };

  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 5 });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  const goal = finished?.goal_state;
  assert.ok(goal, 'goal_state should be persisted');
  assert.equal(goal!.intent, 'analyze the project');
  assert.equal(goal!.phase, 'completed');
  assert.deepEqual(goal!.plan, [{ text: 'read files', status: 'done' }]);
  assert.deepEqual(goal!.decisions, ['focus on server/']);
  assert.equal(goal!.next, '已完成');
});

test('executeRun: final report is blocked until plan items are settled', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'build safely');

  let turn = 0;
  const provider: Provider = {
    name: 'scripted',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{
            id: 'p1',
            name: 'update_plan',
            arguments: JSON.stringify({ plan: [{ text: 'build', status: 'doing' }], next: 'build' }),
          }],
        };
      }
      if (turn === 2) {
        return { content: 'premature', toolCalls: [] };
      }
      if (turn === 3) {
        return {
          content: null,
          toolCalls: [
            {
              id: 'p2',
              name: 'update_plan',
              arguments: JSON.stringify({ phase: 'reporting', plan: [{ text: 'build', status: 'done' }], next: '汇报结果' }),
            },
          ],
        };
      }
      return {
        content: 'done',
        toolCalls: [],
      };
    },
  };

  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 5 });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.goal_state?.plan[0]?.status, 'done');
  const events = await store.getEvents(run.id);
  assert.ok(events.some((event) => event.type === 'final' && event.output === 'done'));
  assert.ok(events.some((event) => event.type === 'plan_update'));
});
