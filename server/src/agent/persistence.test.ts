import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from './context.js';
import { config } from '../config.js';
import { MemoryStore } from '../store/memoryStore.js';
import { maskPlaceholder } from './compaction.js';
import type { ThreadMessage } from '../store/types.js';

// 持久压缩：mask 决策会落库，重载时 store 返回压缩视图，重启也不会丢原始数据。

test('maybeCompact reports the DB ids of newly-masked tool results', async () => {
  const { contextBudget, keepRecentMessages } = config.agent;
  config.agent.contextBudget = 100; // 极小预算用于强制触发压缩。
  config.agent.keepRecentMessages = 1;
  try {
    const prior: ThreadMessage[] = [
      { id: 10, role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      { id: 11, role: 'tool', content: 'x'.repeat(4000), toolCallId: 'c1' },
    ];
    const ctx = new ContextManager(prior, 'continue');
    const res = await ctx.maybeCompact();

    assert.ok(res, 'expected compaction to run');
    assert.deepEqual(res.collapsedIds, [11]); // 大工具结果对应的 DB id。
    assert.ok(res.info.masked >= 1);
    // 工作视图现在显示这条工具消息的占位内容。
    const view = ctx.all();
    assert.ok(view.some((m) => m.content === maskPlaceholder('x'.repeat(4000))));
  } finally {
    config.agent.contextBudget = contextBudget;
    config.agent.keepRecentMessages = keepRecentMessages;
  }
});

test('compactForHistory masks old bulky payloads even below live threshold', () => {
  const { keepRecentMessages } = config.agent;
  config.agent.keepRecentMessages = 2;
  try {
    const bigArgs = JSON.stringify({ path: 'generated/report.txt', content: 'z'.repeat(3000) });
    const prior: ThreadMessage[] = [
      { id: 20, role: 'assistant', content: null, toolCalls: [{ id: 'file1', name: 'file_write', arguments: bigArgs }] },
      { id: 21, role: 'tool', content: 'x'.repeat(4000), toolCallId: 'file1' },
      { id: 22, role: 'assistant', content: null, toolCalls: [{ id: 'p1', name: 'update_plan', arguments: '{}' }] },
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

  // 压缩会把工具结果标记为 masked，executor 持久化的就是这个决策。
  await store.markMessagesCollapsed([toolId], 'masked');

  // 重载后得到 masked 视图，工具配对仍完整，原文不会被销毁。
  const reloaded = await store.loadThreadMessages(thread.id);
  assert.deepEqual(reloaded.map((m) => m.role), ['user', 'assistant', 'tool']);
  const toolMsg = reloaded.find((m) => m.role === 'tool')!;
  assert.equal(toolMsg.collapsed, 'masked');
  assert.equal(toolMsg.content, maskPlaceholder('y'.repeat(3000)));
  assert.equal(toolMsg.toolCallId, 'c1');

  // 从重载视图重建 ContextManager 时，不会再次 mask 已经是占位符的内容。
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
  const args = JSON.stringify({ path: 'generated/report.txt', content: 'u'.repeat(3000) });

  const assistantId = await store.addMessage(thread.id, run.id, null, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'file1', name: 'file_write', arguments: args }],
  });
  await store.addMessage(thread.id, run.id, null, { role: 'tool', content: '文件已写入。', toolCallId: 'file1' });
  await store.markMessagesCollapsed([assistantId], 'masked');

  const reloaded = await store.loadThreadMessages(thread.id);
  const call = reloaded[0].toolCalls?.[0];
  assert.equal(reloaded[0].collapsed, 'masked');
  assert.equal(call?.id, 'file1');
  assert.equal(call?.name, 'file_write');
  assert.ok((call?.arguments.length ?? 0) < args.length);
  const placeholder = JSON.parse(call?.arguments ?? '{}');
  assert.equal(placeholder.context_elided, true);
  assert.equal(placeholder.not_executable, true);
  assert.equal(placeholder.tool_name, 'file_write');
  assert.equal('content' in placeholder, false);
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

test('L3 summaries are promoted and orphan tool results are removed from model view', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'task');

  await store.addMessage(thread.id, run.id, null, { role: 'user', content: '继续' });
  const assistant = await store.addMessage(thread.id, run.id, null, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'search_1', name: 'web_search', arguments: '{}' }],
  });
  await store.addMessage(thread.id, run.id, null, { role: 'tool', content: '搜索结果', toolCallId: 'search_1' });
  await store.addSummaryMessage(thread.id, run.id, null, { role: 'system', content: 'L3 锚定摘要：\n旧上下文摘要' }, [assistant]);
  await store.markMessagesCollapsed([assistant], 'summarized');

  const reloaded = await store.loadThreadMessages(thread.id);
  assert.deepEqual(reloaded.map((m) => m.role), ['system', 'user']);
  assert.match(reloaded[0].content ?? '', /^L3 锚定摘要/);
});

test('incomplete assistant tool calls stay visible for recovery', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'task');

  await store.addMessage(thread.id, run.id, null, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'interrupted_1', name: 'shell_exec', arguments: '{}' }],
  });

  const reloaded = await store.loadThreadMessages(thread.id);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].toolCalls?.[0]?.id, 'interrupted_1');
});
