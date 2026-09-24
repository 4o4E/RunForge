import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePendingMediaTokens, estimateTokens, maskOldAssistantToolCalls, maskOldToolResults, slidingWindow, summaryCandidate, totalChars } from './compaction.js';
import { ContextManager } from './context.js';
import { config } from '../config.js';
import type { LlmMessage, Provider } from '../llm/types.js';
import type { ThreadMessage } from '../store/types.js';
import { segmentToolRoundForSummary } from './contextCompactor.js';
import { readFile } from 'node:fs/promises';

const big = (n: number) => 'x'.repeat(n);

test('完整文档分段摘要保留真实读取状态与片段编号', async () => {
  const content = await readFile(new URL('../../../docs/multi-tenancy-design.md', import.meta.url), 'utf8');
  const messages: LlmMessage[] = [
    { role: 'assistant', content: null, toolCalls: [{ id: 'read-doc', name: 'file_read', arguments: '{"path":"multi-tenancy-design.md"}' }] },
    { role: 'tool', content, toolCallId: 'read-doc' },
  ];
  const segmented = segmentToolRoundForSummary(messages, 6000);
  assert.ok(segmented.chunks.length > 1);
  assert.match(segmented.completeness, /原始结果完整/);
  assert.ok(segmented.chunks.every((chunk) => chunk.length <= 6000 && chunk.includes('分段不是原始结果截断')));
  assert.ok(segmented.chunks.every((chunk) => chunk.includes('原始结果完整')));
  assert.ok(segmented.chunks.some((chunk) => chunk.includes(content.slice(-100))));
});

// A realistic round: assistant requests a tool, tool returns a large result.
function round(id: string, resultChars: number): LlmMessage[] {
  return [
    { role: 'assistant', content: null, toolCalls: [{ id, name: 'read_file', arguments: '{}' }] },
    { role: 'tool', content: big(resultChars), toolCallId: id },
  ];
}

test('estimateTokens scales with content and calibration factor', () => {
  const msgs: LlmMessage[] = [{ role: 'user', content: big(400) }];
  assert.equal(estimateTokens(msgs, 0.25), 200);
  assert.equal(estimateTokens(msgs, 0.75), 300);
});

test('中文与英文混合内容按不同字符比例保守估算', () => {
  const content = '请读取 server/src/agent/executor.ts，并总结最近 3 次工具调用的结果。';
  const estimate = estimateTokens([{ role: 'user', content }]);
  const asciiUnits = Array.from(content).filter((char) => char.codePointAt(0)! <= 0x7f).length;
  const cjkUnits = Array.from(content).filter((char) => /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)).length;
  assert.equal(estimate, Math.ceil(asciiUnits * 0.5 + cjkUnits + (content.length - asciiUnits - cjkUnits) * 0.75));
  assert.ok(estimate > Math.ceil(content.length * 0.25));
});

test('usage 校准不会把字符估算降到语言比例估算以下', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: '请检查这个上下文预算是否足够。' }];
  assert.equal(estimateTokens(messages, 0.15), estimateTokens(messages, 0.25));
  assert.ok(estimateTokens(messages, 1.2) > estimateTokens(messages, 0.25));
});

test('上下文预算只计尚未消费的图片引用', () => {
  const image = { type: 'image' as const, path: 'photo.png', mimeType: 'image/png' };
  const messages: LlmMessage[] = [
    { role: 'user', content: '旧照片', mediaRefs: [image] },
    { role: 'assistant', content: '已阅读。' },
    { role: 'user', content: '新照片', mediaRefs: [image] },
  ];
  assert.equal(estimatePendingMediaTokens(messages), 4096);
  const withoutMedia = estimateTokens(messages.map((message) => ({ ...message, mediaRefs: [] })));
  assert.equal(estimateTokens(messages), withoutMedia + 4096);
});

test('图片引用和 contentParts 指向同一文件时只计一次', () => {
  const image = { type: 'image' as const, path: '/w/report/page-1.png', mimeType: 'image/png' };
  const messages: LlmMessage[] = [{
    role: 'user',
    content: '查看这一页。',
    mediaRefs: [image],
    contentParts: [{ type: 'image', path: image.path, mimeType: image.mimeType, data: 'data' }],
  }];
  assert.equal(estimatePendingMediaTokens(messages), 4096);
});

test('同一路径重复发送图片时逐张计入预算', () => {
  const image = { type: 'image' as const, path: '/w/report/page-1.png', mimeType: 'image/png' };
  const messages: LlmMessage[] = [
    { role: 'user', content: '查看第一页', mediaRefs: [image] },
    { role: 'user', content: '再查看第一页', mediaRefs: [image] },
  ];
  assert.equal(estimatePendingMediaTokens(messages), 8192);
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

test('maskOldAssistantToolCalls drops old encrypted reasoning even when tool args are small', () => {
  const messages: LlmMessage[] = [
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
      providerState: {
        reasoningParts: [{
          text: '',
          providerOptions: { openai: { reasoningEncryptedContent: 'encrypted' } },
        }],
      },
    },
    { role: 'tool', content: 'ok', toolCallId: 'c1' },
    { role: 'user', content: 'next' },
  ];
  const { messages: compacted, masked } = maskOldAssistantToolCalls(messages, { keepRecent: 1 });
  assert.equal(masked, 1);
  assert.equal(compacted[0].collapsed, 'masked');
  assert.equal(compacted[0].providerState, undefined);
  assert.equal(compacted[0].toolCalls?.[0].arguments, '{}');
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

test('slidingWindow keeps the latest L3 summary instead of an obsolete first user anchor', () => {
  const olderSummary: LlmMessage = {
    role: 'system',
    content: 'L3 锚定摘要：旧状态',
    collapsed: 'summarized',
  };
  const summary: LlmMessage = {
    role: 'system',
    content: 'L3 锚定摘要：最新 Goal 状态和当前结果路径',
    collapsed: 'summarized',
  };
  const msgs: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    olderSummary,
    { role: 'user', content: 'obsolete request' },
    summary,
    ...round('c1', 100),
    ...round('c2', 100),
  ];

  const { messages, dropped } = slidingWindow(msgs, { keepRecent: 2 });

  assert.ok(dropped > 0);
  assert.ok(messages.includes(summary));
  assert.equal(messages.includes(olderSummary), false);
  assert.equal(messages.some((message) => message.content === 'obsolete request'), false);
  for (const message of messages.filter((item) => item.role === 'tool')) {
    assert.ok(messages.some((parent) => parent.toolCalls?.some((call) => call.id === message.toolCallId)));
  }
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

test('current compaction keeps the latest Goal summary when L2 follows L3', async () => {
  const { contextBudget, keepRecentMessages, contextStrategy } = config.agent;
  config.agent.contextBudget = 100;
  config.agent.keepRecentMessages = 1;
  config.agent.contextStrategy = 'current';
  try {
    const prior: ThreadMessage[] = [
      { id: 1, role: 'user', content: 'original request' },
      { id: 2, role: 'assistant', content: big(2000) },
      { id: 3, role: 'user', content: 'more work' },
      { id: 4, role: 'assistant', content: big(2000) },
    ];
    let summaryRequest = '';
    const provider: Provider = {
      name: 'summary-capture',
      async completeStream(messages) {
        summaryRequest = messages.map((message) => message.content ?? '').join('\n');
        return { content: 'compressed history', toolCalls: [] };
      },
    };
    const context = new ContextManager(prior, 'continue', 'LATEST GOAL STATE', { systemPrompt: big(1000) });
    assert.equal(context.all().some((message) => message.content === 'LATEST GOAL STATE'), false);
    await context.maybeCompact(provider);
    assert.match(summaryRequest, /LATEST GOAL STATE/);
    assert.ok(context.all().some((message) => (
      message.collapsed === 'summarized' && (message.content ?? '').includes('LATEST GOAL STATE')
    )));
    assert.equal(context.all().some((message) => message.content === 'original request'), false);
    assert.ok(context.all().some((message) => message.content === 'continue'));
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
    assert.equal(view.some((m) => m.role === 'system' && m.content === 'GOAL: keep working'), false);
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
