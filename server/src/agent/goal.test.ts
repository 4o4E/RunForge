import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initGoal, mergeGoal, parseGoalPatch, renderGoal } from './goal.js';
import { executeRun } from './executor.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { Provider } from '../llm/types.js';

test('mergeGoal: plan/next replace, decisions append, intent fixed', () => {
  const g0 = initGoal('build the thing');
  const g1 = mergeGoal(g0, { plan: [{ text: 'a', status: 'doing' }], decisions: ['d1'], next: 'do a' });
  const g2 = mergeGoal(g1, { plan: [{ text: 'a', status: 'done' }], decisions: ['d2'], next: 'do b' });

  assert.equal(g2.intent, 'build the thing'); // never changes
  assert.deepEqual(g2.plan, [{ text: 'a', status: 'done' }]); // replaced
  assert.deepEqual(g2.decisions, ['d1', 'd2']); // appended, never lost
  assert.equal(g2.next, 'do b');
});

test('renderGoal: compact, includes intent + plan checkboxes + next', () => {
  const text = renderGoal({
    intent: 'X',
    plan: [{ text: 'one', status: 'done' }, { text: 'two', status: 'todo' }],
    decisions: ['keep Y'],
    next: 'do two',
  });
  assert.match(text, /Intent: X/);
  assert.match(text, /\[x\] one/);
  assert.match(text, /\[ \] two/);
  assert.match(text, /keep Y/);
  assert.match(text, /Next: do two/);
});

test('parseGoalPatch: coerces messy args, drops invalid', () => {
  const patch = parseGoalPatch({
    plan: [{ text: 'a', status: 'doing' }, { text: '', status: 'todo' }, { status: 'bad' }],
    decisions: ['d1', ''],
    next: 'go',
  });
  assert.deepEqual(patch.plan, [{ text: 'a', status: 'doing' }]); // empty/invalid dropped
  assert.deepEqual(patch.decisions, ['d1']);
  assert.equal(patch.next, 'go');
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
      return {
        content: 'done',
        toolCalls: [{
          id: 'f1',
          name: 'finish_conversation',
          arguments: JSON.stringify({ progress: 'done', completed: true }),
        }],
      };
    },
  };

  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 5 });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  const goal = finished?.goal_state;
  assert.ok(goal, 'goal_state should be persisted');
  assert.equal(goal!.intent, 'analyze the project');
  assert.deepEqual(goal!.plan, [{ text: 'read files', status: 'doing' }]);
  assert.deepEqual(goal!.decisions, ['focus on server/']);
  assert.equal(goal!.next, 'read executor.ts');
});
