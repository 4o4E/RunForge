import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun } from './executor.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { Provider } from '../llm/types.js';
import type { AgentEvent } from './types.js';

// A provider that calls the `glob` tool on its first turn, then finalizes.
function scriptedProvider(): Provider {
  let turn = 0;
  return {
    name: 'scripted',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return { content: null, toolCalls: [{ id: 'call_1', name: 'glob', arguments: '{"pattern":"**/*.json"}' }] };
      }
      return { content: 'all done', toolCalls: [] };
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
    maxSteps: 5,
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'all done');

  // Two steps: step 1 (tool call), step 2 (final).
  const types = published.map((e) => `${e.step}:${e.type}`);
  assert.deepEqual(types, [
    '1:step_start',
    '1:tool_call',
    '1:tool_result',
    '2:step_start',
    '2:llm_delta',
    '2:final',
  ]);

  // Conversation persisted as user + assistant(toolcall) + tool + assistant(final).
  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
});

test('executeRun: keeps multi-turn memory within a thread', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();

  const run1 = await store.createRun(thread.id, 'first');
  await executeRun(run1.id, {
    store,
    provider: { name: 's', async complete() { return { content: 'ok1', toolCalls: [] }; } },
    publish: () => {},
    maxSteps: 3,
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
        return { content: 'ok2', toolCalls: [] };
      },
    },
    publish: () => {},
    maxSteps: 3,
  });

  // prior: user(first) + assistant(ok1) + new user(second) = 3
  assert.equal(seenPriorCount, 3);
});

test('executeRun: stops and errors at max steps', async () => {
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
    maxSteps: 2,
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'error');
  assert.match(finished?.error ?? '', /max steps/);
});
