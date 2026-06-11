import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun } from './executor.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { Provider } from '../llm/types.js';
import type { AgentEvent } from './types.js';

function finishCall(id: string, progress: string, completed = true) {
  return {
    id,
    name: 'finish_conversation',
    arguments: JSON.stringify({ progress, completed }),
  };
}

// A provider that calls the `glob` tool on its first turn, then ends explicitly.
function scriptedProvider(): Provider {
  let turn = 0;
  return {
    name: 'scripted',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return { content: null, toolCalls: [{ id: 'call_1', name: 'glob', arguments: '{"pattern":"**/*.json"}' }] };
      }
      return { content: 'all done', toolCalls: [finishCall('finish_1', 'all done')] };
    },
  };
}

test('executeRun: runs the loop across steps and finalizes', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'find json files');

  const published: AgentEvent[] = [];
  await executeRun(run.id, {
    store,
    provider: scriptedProvider(),
    publish: (_id, e) => published.push(e),
    hardStepCap: 5,
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'all done');

  // Two steps: step 1 (tool call), step 2 (explicit finish tool).
  const types = published.map((e) => `${e.step}:${e.type}`);
  assert.deepEqual(types, [
    '1:step_start',
    '1:tool_call',
    '1:tool_result',
    '2:step_start',
    '2:llm_delta',
    '2:tool_call',
    '2:tool_result',
    '2:final',
  ]);

  // Conversation persisted as user + assistant/tool for glob + assistant/tool for finish.
  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool']);
});

test('executeRun: keeps multi-turn memory within a thread', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();

  const run1 = await store.createRun(thread.id, 'first');
  await executeRun(run1.id, {
    store,
    provider: { name: 's', async complete() { return { content: 'ok1', toolCalls: [finishCall('f1', 'ok1')] }; } },
    publish: () => {},
    hardStepCap: 3,
  });

  // Second run should see the first run's messages as prior context.
  let seenPriorCount = 0;
  const run2 = await store.createRun(thread.id, 'second');
  await executeRun(run2.id, {
    store,
    provider: {
      name: 's',
      async complete(messages) {
        seenPriorCount = messages.filter((m) => m.role !== 'system').length;
        return { content: 'ok2', toolCalls: [finishCall('f2', 'ok2')] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
  });

  // prior: user(first) + assistant(finish call) + tool(finish result) + new user(second) = 4
  assert.equal(seenPriorCount, 4);
});

test('executeRun: text without finish_conversation is not completion', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'answer directly');

  await executeRun(run.id, {
    store,
    provider: {
      name: 'no-finish',
      async complete() {
        return { content: 'premature final answer', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 2,
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'error');
  assert.match(finished?.error ?? '', /hard step cap/);
});

test('executeRun: stops and errors at the hard step cap', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'loop forever');

  await executeRun(run.id, {
    store,
    // Always asks for a tool, never finalizes.
    provider: {
      name: 'looper',
      async complete() {
        return { content: null, toolCalls: [{ id: 'c', name: 'glob', arguments: '{"pattern":"*"}' }] };
      },
    },
    publish: () => {},
    hardStepCap: 2,
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'error');
  assert.match(finished?.error ?? '', /hard step cap/);
});

test('executeRun: cancels cooperatively at a step boundary', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'long task');

  // Flip the run to 'canceling' the moment the loop starts its first step, so the
  // top-of-step check observes it and stops before finalizing.
  let turn = 0;
  await executeRun(run.id, {
    store,
    provider: {
      name: 'looper',
      async complete() {
        turn += 1;
        if (turn === 1) await store.setRunStatus(run.id, 'canceling');
        return { content: null, toolCalls: [{ id: 'c', name: 'glob', arguments: '{"pattern":"*"}' }] };
      },
    },
    publish: () => {},
    hardStepCap: 50,
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'canceled');
});

test('executeRun: ask_user pauses the run and keeps tool pairing intact', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'needs clarification');
  const published: AgentEvent[] = [];

  await executeRun(run.id, {
    store,
    provider: {
      name: 'asker',
      async complete() {
        return {
          content: null,
          toolCalls: [
            {
              id: 'ask_1',
              name: 'ask_user',
              arguments:
                '{"question":"继续吗？","mode":"single","allowCustom":true,"required":true,"options":[{"id":"yes","label":"继续","recommended":true,"required":true},{"id":"no","label":"暂停"}]}',
            },
          ],
        };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
  });

  const paused = await store.getRun(run.id);
  assert.equal(paused?.status, 'waiting_for_user');
  assert.ok(published.some((e) => e.type === 'user_question' && e.question === '继续吗？'));
  const question = published.find((e) => e.type === 'user_question');
  assert.equal(question?.type === 'user_question' ? question.spec?.mode : undefined, 'single');
  assert.equal(question?.type === 'user_question' ? question.spec?.allowCustom : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.required : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.options[0]?.recommended : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.options[0]?.required : undefined, true);

  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[2].toolCallId, 'ask_1');
});

test('executeRun: resumes the same run after a user answer without duplicating input', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'needs answer');
  let turn = 0;
  const provider: Provider = {
    name: 'resume',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{ id: 'ask_1', name: 'ask_user', arguments: '{"question":"选 A 还是 B？"}' }],
        };
      }
      return { content: 'ok', toolCalls: [finishCall('finish_1', 'used answer')] };
    },
  };

  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3 });
  await store.addMessage(thread.id, run.id, null, { role: 'user', content: '用户回答 / User answer:\nA' });
  await store.setRunStatus(run.id, 'pending');
  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, resume: true });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'used answer');
  const msgs = await store.loadThreadMessages(thread.id);
  assert.equal(msgs.filter((m) => m.role === 'user' && m.content === 'needs answer').length, 1);
  assert.ok(msgs.some((m) => m.role === 'user' && m.content?.includes('User answer')));
});

test('memory store: deleteThread removes dependent run data', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'delete me');
  await store.addMessage(thread.id, run.id, null, { role: 'user', content: 'delete me' });
  await store.addEvent(run.id, null, { type: 'final', step: 1, output: 'done' });

  assert.equal(await store.deleteThread(thread.id), true);
  assert.equal(await store.getThread(thread.id), null);
  assert.deepEqual(await store.listRuns(thread.id), []);
  assert.deepEqual(await store.loadThreadMessages(thread.id), []);
  assert.deepEqual(await store.getEvents(run.id), []);
});
