import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, maskOldAssistantToolCalls, maskOldToolResults, slidingWindow, summaryCandidate, totalChars } from './compaction.js';
import { ContextManager } from './context.js';
import { config } from '../config.js';
import type { LlmMessage } from '../llm/types.js';
import type { ThreadMessage } from '../store/types.js';

const big = (n: number) => 'x'.repeat(n);

// A realistic round: assistant requests a tool, tool returns a large result.
function round(id: string, resultChars: number): LlmMessage[] {
  return [
    { role: 'assistant', content: null, toolCalls: [{ id, name: 'read_file', arguments: '{}' }] },
    { role: 'tool', content: big(resultChars), toolCallId: id },
  ];
}

test('estimateTokens scales with content and calibration factor', () => {
  const msgs: LlmMessage[] = [{ role: 'user', content: big(400) }];
  assert.equal(estimateTokens(msgs, 0.25), 100);
  assert.equal(estimateTokens(msgs, 0.5), 200);
});

test('maskOldToolResults elides old large tool outputs but keeps pairing', () => {
  const msgs: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do it' },
    ...round('c1', 3000), // old → should mask
    ...round('c2', 3000), // recent → kept
  ];
  const { messages, masked } = maskOldToolResults(msgs, { keepRecent: 2 });

  assert.equal(masked, 1);
  // c1 tool result masked, structure & toolCallId intact.
  const t1 = messages.find((m) => m.toolCallId === 'c1')!;
  assert.equal(t1.collapsed, 'masked');
  assert.match(t1.content ?? '', /chars elided/); // head hint + elision marker
  assert.ok((t1.content ?? '').length < 3000); // much smaller than the original
  // c2 (recent) untouched.
  const t2 = messages.find((m) => m.toolCallId === 'c2')!;
  assert.equal(t2.collapsed, undefined);
  assert.equal(t2.content?.length, 3000);
  // Every tool message still has its assistant parent → no orphans.
  for (const m of messages.filter((x) => x.role === 'tool')) {
    assert.ok(messages.some((a) => a.toolCalls?.some((tc) => tc.id === m.toolCallId)));
  }
});

test('maskOldToolResults leaves small tool outputs alone', () => {
  const msgs: LlmMessage[] = [{ role: 'user', content: 'q' }, ...round('c1', 50), ...round('c2', 3000)];
  const { masked } = maskOldToolResults(msgs, { keepRecent: 0 });
  assert.equal(masked, 1); // only the 3000-char one
});

test('maskOldAssistantToolCalls elides old large tool arguments but keeps ids', () => {
  const hugeArgs = JSON.stringify({ path: 'generated/report.txt', content: big(3000) });
  const msgs: LlmMessage[] = [
    { role: 'user', content: 'write report file' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'file1', name: 'file_write', arguments: hugeArgs }] },
    { role: 'tool', content: '文件已写入。', toolCallId: 'file1' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'p1', name: 'update_plan', arguments: '{}' }] },
  ];

  const { messages, masked } = maskOldAssistantToolCalls(msgs, { keepRecent: 1 });

  assert.equal(masked, 1);
  const call = messages[1].toolCalls?.[0];
  assert.equal(messages[1].collapsed, 'masked');
  assert.equal(call?.id, 'file1');
  assert.equal(call?.name, 'file_write');
  assert.ok((call?.arguments.length ?? 0) < hugeArgs.length);
  const placeholder = JSON.parse(call?.arguments ?? '{}');
  assert.equal(placeholder.context_elided, true);
  assert.equal(placeholder.not_executable, true);
  assert.equal(placeholder.tool_name, 'file_write');
  assert.equal('content' in placeholder, false);
  assert.ok(messages.some((m) => m.role === 'tool' && m.toolCallId === call?.id));
});

test('maskOldAssistantToolCalls masks forced tools even when recent', () => {
  const hugeArgs = JSON.stringify({ payload: big(3000) });
  const msgs: LlmMessage[] = [
    { role: 'user', content: 'render report' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'render1', name: 'render_page', arguments: hugeArgs }] },
  ];

  const { messages, masked } = maskOldAssistantToolCalls(msgs, { keepRecent: 10, forceToolNames: ['render_page'] });

  assert.equal(masked, 1);
  assert.equal(messages[1].collapsed, 'masked');
  const placeholder = JSON.parse(messages[1].toolCalls?.[0]?.arguments ?? '{}');
  assert.equal(placeholder.context_elided, true);
  assert.equal(placeholder.not_executable, true);
  assert.equal('payload' in placeholder, false);
});

test('maskOldAssistantToolCalls keeps non-forced recent tool args', () => {
  const hugeArgs = JSON.stringify({ command: big(3000) });
  const msgs: LlmMessage[] = [
    { role: 'user', content: 'run' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'sh1', name: 'shell', arguments: hugeArgs }] },
  ];

  const { messages, masked } = maskOldAssistantToolCalls(msgs, { keepRecent: 10, forceToolNames: ['render_page'] });

  assert.equal(masked, 0);
  assert.equal(messages[1].collapsed, undefined);
  assert.equal(messages[1].toolCalls?.[0]?.arguments, hugeArgs);
});

test('slidingWindow keeps system + first user anchor and cuts on a safe boundary', () => {
  const msgs: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'original request' },
    ...round('c1', 100),
    ...round('c2', 100),
    ...round('c3', 100),
  ];
  const { messages, dropped } = slidingWindow(msgs, { keepRecent: 2 });

  // System + anchor preserved.
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'original request');
  assert.ok(dropped > 0);
  // No orphan tool results: every kept tool has its assistant parent.
  for (const m of messages.filter((x) => x.role === 'tool')) {
    assert.ok(messages.some((a) => a.toolCalls?.some((tc) => tc.id === m.toolCallId)));
  }
  // Result is smaller than the input.
  assert.ok(totalChars(messages) < totalChars(msgs));
});

test('summaryCandidate does not split assistant tool calls from later results', () => {
  const msgs: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'original request' },
    ...round('c1', 100),
    ...round('c2', 100),
    ...round('c3', 100),
  ];

  const candidate = summaryCandidate(msgs, { keepRecent: 1 });
  assert.ok(candidate);
  const summarized = new Set(candidate.messages);
  for (const message of msgs) {
    if (message.role !== 'tool') continue;
    const parent = msgs.find((item) => item.toolCalls?.some((call) => call.id === message.toolCallId));
    assert.equal(summarized.has(message), summarized.has(parent!));
  }
});

test('slidingWindow never starts a window on an orphan tool message', () => {
  // keepRecent lands mid-round (on a tool message); the window must walk forward.
  const msgs: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'req' },
    ...round('c1', 100),
    ...round('c2', 100),
  ];
  const { messages } = slidingWindow(msgs, { keepRecent: 1 });
  const firstNonHead = messages.find((m) => m.role !== 'system' && m.content !== 'req');
  assert.notEqual(firstNonHead?.role, 'tool');
});

test('context strategy defaults to current compaction behavior', async () => {
  const { contextBudget, keepRecentMessages, contextStrategy } = config.agent;
  config.agent.contextBudget = 100;
  config.agent.keepRecentMessages = 1;
  config.agent.contextStrategy = 'current';
  try {
    const prior: ThreadMessage[] = [
      { id: 10, role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      { id: 11, role: 'tool', content: big(4000), toolCallId: 'c1' },
    ];
    const ctx = new ContextManager(prior, 'continue');
    const res = await ctx.maybeCompact();

    assert.ok(res);
    assert.deepEqual(res.collapsedIds, [11]);
    assert.equal(res.info.masked, 1);
    assert.match(res.info.reason ?? '', /strategy=current/);
  } finally {
    config.agent.contextBudget = contextBudget;
    config.agent.keepRecentMessages = keepRecentMessages;
    config.agent.contextStrategy = contextStrategy;
  }
});

test('langchain-trim preserves anchors, repairs tool pairs and leaves source messages unchanged', async () => {
  const { contextBudget, keepRecentMessages, contextStrategy } = config.agent;
  config.agent.contextBudget = 80;
  config.agent.keepRecentMessages = 2;
  config.agent.contextStrategy = 'langchain-trim';
  try {
    const prior: ThreadMessage[] = [
      { id: 1, role: 'user', content: 'original request anchor' },
      { id: 2, role: 'assistant', content: 'plain history ' + big(120) },
      { id: 3, role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      { id: 4, role: 'tool', content: 'tool result one ' + big(40), toolCallId: 'c1' },
      { id: 5, role: 'assistant', content: null, toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{}' }] },
      { id: 6, role: 'tool', content: 'tool result two ' + big(40), toolCallId: 'c2' },
      { id: 7, role: 'assistant', content: 'recent plain history ' + big(120) },
    ];
    const before = JSON.stringify(prior);
    const ctx = new ContextManager(prior, 'continue', 'GOAL: keep working');
    const res = await ctx.maybeCompact();
    const view = ctx.all();

    assert.ok(res);
    assert.match(res.info.reason ?? '', /strategy=langchain-trim/);
    assert.ok(view.some((m) => m.role === 'system' && m.content === 'GOAL: keep working'));
    assert.ok(view.some((m) => m.role === 'user' && m.content === 'original request anchor'));
    assert.equal(JSON.stringify(prior), before);

    for (const message of view) {
      if (message.role === 'tool') {
        assert.ok(view.some((parent) => parent.toolCalls?.some((call) => call.id === message.toolCallId)));
      }
      for (const call of message.toolCalls ?? []) {
        assert.ok(view.some((tool) => tool.role === 'tool' && tool.toolCallId === call.id));
      }
    }
  } finally {
    config.agent.contextBudget = contextBudget;
    config.agent.keepRecentMessages = keepRecentMessages;
    config.agent.contextStrategy = contextStrategy;
  }
});
