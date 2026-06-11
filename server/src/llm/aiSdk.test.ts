import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toModelMessages } from './providers/aiSdk.js';
import type { LlmMessage } from './types.js';

test('toModelMessages: maps system/user/assistant/tool roles', () => {
  const msgs: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'let me check',
      toolCalls: [{ id: 'c1', name: 'glob', arguments: '{"pattern":"*"}' }],
    },
    { role: 'tool', content: 'a.txt\nb.txt', toolCallId: 'c1' },
    { role: 'assistant', content: 'done' },
  ];

  const out = toModelMessages(msgs);
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'assistant'],
  );

  // Assistant tool-call turn becomes text + tool-call content parts.
  const asst = out[2];
  assert.equal(asst.role, 'assistant');
  const parts = asst.content as Array<{ type: string; toolName?: string; toolCallId?: string }>;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'tool-call']);
  assert.equal(parts[1].toolName, 'glob');
  assert.equal(parts[1].toolCallId, 'c1');

  // Tool result recovers the tool name from the owning call id and wraps output.
  const toolMsg = out[3] as { role: string; content: Array<{ type: string; toolName: string; output: unknown }> };
  assert.equal(toolMsg.content[0].type, 'tool-result');
  assert.equal(toolMsg.content[0].toolName, 'glob');
  assert.deepEqual(toolMsg.content[0].output, { type: 'text', value: 'a.txt\nb.txt' });
});

test('toModelMessages: assistant without tool calls is a plain string', () => {
  const out = toModelMessages([{ role: 'assistant', content: 'plain' }]);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'plain');
});

test('toModelMessages: malformed tool-call args degrade to empty object', () => {
  const out = toModelMessages([
    { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'shell', arguments: 'not json' }] },
  ]);
  const parts = out[0].content as Array<{ type: string; input?: unknown }>;
  // No leading text part (content was null); just the tool-call.
  assert.deepEqual(parts.map((p) => p.type), ['tool-call']);
  assert.deepEqual(parts[0].input, {});
});
