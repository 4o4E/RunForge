import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from './context.js';
import { config } from '../config.js';
import { MemoryStore } from '../store/memoryStore.js';
import { maskPlaceholder } from './compaction.js';
import type { ThreadMessage } from '../store/types.js';

// Durable compaction (long-task design §4): masking decisions are persisted and the
// store returns the compacted view on reload, so a restart loses no data.

test('maybeCompact reports the DB ids of newly-masked tool results', () => {
  const { contextBudget, keepRecentMessages } = config.agent;
  config.agent.contextBudget = 100; // tiny budget → force compaction
  config.agent.keepRecentMessages = 1;
  try {
    const prior: ThreadMessage[] = [
      { id: 10, role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      { id: 11, role: 'tool', content: 'x'.repeat(4000), toolCallId: 'c1' },
    ];
    const ctx = new ContextManager(prior, 'continue');
    const res = ctx.maybeCompact();

    assert.ok(res, 'expected compaction to run');
    assert.deepEqual(res.collapsedIds, [11]); // the big tool result's DB id
    assert.ok(res.info.masked >= 1);
    // The working view now shows the placeholder for that tool message.
    const view = ctx.all();
    assert.ok(view.some((m) => m.content === maskPlaceholder(4000)));
  } finally {
    config.agent.contextBudget = contextBudget;
    config.agent.keepRecentMessages = keepRecentMessages;
  }
});

test('store persists collapsed flag and returns the masked view on reload', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'task');

  await store.addMessage(thread.id, run.id, null, { role: 'user', content: 'do it' });
  await store.addMessage(thread.id, run.id, null, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
  });
  const toolId = await store.addMessage(thread.id, run.id, null, {
    role: 'tool',
    content: 'y'.repeat(3000),
    toolCallId: 'c1',
  });

  // Compaction marks the tool result masked (what the executor persists).
  await store.markMessagesCollapsed([toolId], 'masked');

  // Reload (as a fresh run / after a restart would) → masked view, pairing intact,
  // and the original is NOT destroyed (placeholder length matches the original).
  const reloaded = await store.loadThreadMessages(thread.id);
  assert.deepEqual(reloaded.map((m) => m.role), ['user', 'assistant', 'tool']);
  const toolMsg = reloaded.find((m) => m.role === 'tool')!;
  assert.equal(toolMsg.collapsed, 'masked');
  assert.equal(toolMsg.content, maskPlaceholder(3000));
  assert.equal(toolMsg.toolCallId, 'c1');

  // A ContextManager rebuilt from the reloaded view does NOT re-mask the placeholder.
  const ctx = new ContextManager(reloaded, 'next');
  assert.ok(ctx.all().some((m) => m.content === maskPlaceholder(3000)));
});

test('summarized rows are omitted from the reloaded view', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'task');

  const a = await store.addMessage(thread.id, run.id, null, { role: 'user', content: 'old turn' });
  await store.addMessage(thread.id, run.id, null, { role: 'assistant', content: 'kept' });
  await store.markMessagesCollapsed([a], 'summarized');

  const reloaded = await store.loadThreadMessages(thread.id);
  assert.deepEqual(reloaded.map((m) => m.content), ['kept']);
});
