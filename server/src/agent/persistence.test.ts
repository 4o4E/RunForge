import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from './context.js';
import { config } from '../config.js';
import { MemoryStore } from '../store/memoryStore.js';
import { maskPlaceholder } from './compaction.js';
import type { ThreadMessage } from '../store/types.js';

// Durable compaction (long-task design §4): masking decisions are persisted and the
// store returns the compacted view on reload, so a restart loses no data.

test('maybeCompact reports the DB ids of newly-masked tool results', async () => {
  const { contextBudget, keepRecentMessages } = config.agent;
  config.agent.contextBudget = 100; // tiny budget → force compaction
  config.agent.keepRecentMessages = 1;
  try {
    const prior: ThreadMessage[] = [
      { id: 10, role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      { id: 11, role: 'tool', content: 'x'.repeat(4000), toolCallId: 'c1' },
    ];
    const ctx = new ContextManager(prior, 'continue');
    const res = await ctx.maybeCompact();

    assert.ok(res, 'expected compaction to run');
    assert.deepEqual(res.collapsedIds, [11]); // the big tool result's DB id
    assert.ok(res.info.masked >= 1);
    // The working view now shows the placeholder for that tool message.
    const view = ctx.all();
    assert.ok(view.some((m) => m.content === maskPlaceholder('x'.repeat(4000))));
  } finally {
    config.agent.contextBudget = contextBudget;
    config.agent.keepRecentMessages = keepRecentMessages;
  }
});

test('maybeCompact masks display tool args even below the warn threshold', async () => {
  const prior: ThreadMessage[] = [
    {
      id: 30,
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'ui1', name: 'render_ui', arguments: JSON.stringify({ components: 'z'.repeat(3000) }) }],
    },
    { id: 31, role: 'tool', content: 'UI rendered.', toolCallId: 'ui1' },
  ];
  const ctx = new ContextManager(prior, 'continue');
  const res = await ctx.maybeCompact();

  assert.ok(res, 'expected display payload compaction to run');
  assert.equal(res.info.reason, 'display-payload');
  assert.equal(res.info.summarized, 0);
  assert.deepEqual(res.collapsedIds, [30]);
});

test('compactForHistory masks old bulky payloads even below live threshold', () => {
  const { keepRecentMessages } = config.agent;
  config.agent.keepRecentMessages = 2;
  try {
    const bigArgs = JSON.stringify({ components: 'z'.repeat(3000) });
    const prior: ThreadMessage[] = [
      { id: 20, role: 'assistant', content: null, toolCalls: [{ id: 'ui1', name: 'render_ui', arguments: bigArgs }] },
      { id: 21, role: 'tool', content: 'x'.repeat(4000), toolCallId: 'ui1' },
      { id: 22, role: 'assistant', content: null, toolCalls: [{ id: 'f1', name: 'finish_conversation', arguments: '{}' }] },
    ];
    const ctx = new ContextManager(prior, 'continue');
    const res = ctx.compactForHistory();

    assert.ok(res, 'expected history compaction to mask old payloads');
    assert.deepEqual(res.collapsedIds, [20, 21]);
    assert.equal(res.info.reason, 'post-run-history');
    assert.equal(res.info.summarized, 0);
    assert.ok(res.info.estAfter < res.info.estBefore);
  } finally {
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
  assert.equal(toolMsg.content, maskPlaceholder('y'.repeat(3000)));
  assert.equal(toolMsg.toolCallId, 'c1');

  // A ContextManager rebuilt from the reloaded view does NOT re-mask the placeholder.
  const ctx = new ContextManager(reloaded, 'next');
  assert.ok(ctx.all().some((m) => m.content === maskPlaceholder('y'.repeat(3000))));
});

test('store uses typed prefixes for thread, run and step ids', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'task');
  const step = await store.createStep(run.id, 1);

  assert.match(thread.id, /^th_[0-9A-Za-z]+$/);
  assert.match(run.id, /^ru_[0-9A-Za-z]+$/);
  assert.match(step.id, /^st_[0-9A-Za-z]+$/);
});

test('store returns masked assistant tool-call args on reload', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'task');
  const args = JSON.stringify({ components: 'u'.repeat(3000) });

  const assistantId = await store.addMessage(thread.id, run.id, null, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'ui1', name: 'render_ui', arguments: args }],
  });
  await store.addMessage(thread.id, run.id, null, { role: 'tool', content: 'UI rendered.', toolCallId: 'ui1' });
  await store.markMessagesCollapsed([assistantId], 'masked');

  const reloaded = await store.loadThreadMessages(thread.id);
  const call = reloaded[0].toolCalls?.[0];
  assert.equal(reloaded[0].collapsed, 'masked');
  assert.equal(call?.id, 'ui1');
  assert.equal(call?.name, 'render_ui');
  assert.ok((call?.arguments.length ?? 0) < args.length);
  const placeholder = JSON.parse(call?.arguments ?? '{}');
  assert.equal(placeholder.context_elided, true);
  assert.equal(placeholder.not_executable, true);
  assert.equal(placeholder.tool_name, 'render_ui');
  assert.equal('root' in placeholder, false);
  assert.equal('components' in placeholder, false);
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

test('summary messages reload at the position of the folded rows', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'task');

  const old = await store.addMessage(thread.id, run.id, null, { role: 'assistant', content: 'old detail' });
  await store.addMessage(thread.id, run.id, null, { role: 'assistant', content: 'recent detail' });
  await store.addSummaryMessage(thread.id, run.id, null, { role: 'system', content: 'summary of old detail' }, [old]);
  await store.markMessagesCollapsed([old], 'summarized');

  const reloaded = await store.loadThreadMessages(thread.id);
  assert.deepEqual(reloaded.map((m) => m.content), ['summary of old detail', 'recent detail']);
});
