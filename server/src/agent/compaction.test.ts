import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, maskOldToolResults, slidingWindow, totalChars } from './compaction.js';
import type { LlmMessage } from '../llm/types.js';

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
  assert.match(t1.content ?? '', /tool output elided · 3000 chars/);
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
