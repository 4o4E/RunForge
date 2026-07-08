import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponsesRequest, parseResponsesOutput } from './providers/openaiResponses.js';
import { applyStreamChunk, buildChatRequest, parseChatResponse } from './providers/openaiChat.js';
import { buildAnthropicRequest, parseAnthropicResponse } from './providers/anthropic.js';
import { createMockProvider } from './providers/mock.js';
import type { LlmMessage, LlmTool } from './types.js';

const TOOLS: LlmTool[] = [
  { name: 'echo', description: 'echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
];

const CONVO: LlmMessage[] = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
  { role: 'tool', content: 'hi', toolCallId: 'call_1' },
];

const IMAGE_MESSAGE: LlmMessage = {
  role: 'user',
  content: 'look',
  contentParts: [
    { type: 'text', text: 'look' },
    { type: 'image', data: 'aW1n', mimeType: 'image/png', path: 'photo.png', name: 'photo.png' },
  ],
};

test('openai-responses: builds request with instructions + function_call items', () => {
  const req = buildResponsesRequest(CONVO, TOOLS, { model: 'gpt-x', maxTokens: 100 });
  assert.equal(req.model, 'gpt-x');
  assert.equal(req.instructions, 'be brief');
  assert.equal(req.tools?.[0].type, 'function');
  assert.equal(req.tools?.[0].name, 'echo'); // flat, not nested under "function"
  // input should contain the user msg, the function_call, and the function_call_output
  const types = req.input.map((i) => (i as { type?: string; role?: string }).type ?? (i as { role?: string }).role);
  assert.deepEqual(types, ['user', 'function_call', 'function_call_output']);
});

test('openai-responses: maps image parts to input_image content', () => {
  const req = buildResponsesRequest([IMAGE_MESSAGE], [], { model: 'gpt-x', maxTokens: 100 });
  const user = req.input[0] as { role: string; content: Array<{ type: string; image_url?: string }> };
  assert.equal(user.role, 'user');
  assert.deepEqual(user.content.map((part) => part.type), ['input_text', 'input_image']);
  assert.equal(user.content[1].image_url, 'data:image/png;base64,aW1n');
});

test('openai-responses: parses message text and function_call output', () => {
  const result = parseResponsesOutput({
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { type: 'function_call', call_id: 'call_9', name: 'echo', arguments: '{"text":"x"}' },
    ],
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  assert.equal(result.content, 'answer');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_9');
  assert.equal(result.usage?.outputTokens, 7);
  assert.equal(result.finishReason, 'tool-calls');
});

test('openai-responses: maps incomplete max output to length finish reason', () => {
  const result = parseResponsesOutput({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
  });
  assert.equal(result.content, 'partial');
  assert.equal(result.finishReason, 'length');
  assert.equal(result.rawFinishReason, 'max_output_tokens');
});

test('openai-chat: builds nested function tool defs and tool messages', () => {
  const req = buildChatRequest(CONVO, TOOLS, 'gpt-x');
  assert.equal(req.tools?.[0].function.name, 'echo'); // nested under "function"
  const toolMsg = req.messages.find((m) => m.role === 'tool') as { tool_call_id?: string };
  assert.equal(toolMsg.tool_call_id, 'call_1');
});

test('openai-chat: maps image parts to image_url content', () => {
  const req = buildChatRequest([IMAGE_MESSAGE], [], 'gpt-x');
  const user = req.messages[0] as { role: string; content: Array<{ type: string; image_url?: { url: string } }> };
  assert.equal(user.role, 'user');
  assert.deepEqual(user.content.map((part) => part.type), ['text', 'image_url']);
  assert.equal(user.content[1].image_url?.url, 'data:image/png;base64,aW1n');
});

test('openai-chat: parses tool_calls', () => {
  const result = parseChatResponse({
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{}' } }] } }],
  });
  assert.equal(result.toolCalls[0].name, 'echo');
  assert.equal(result.finishReason, 'tool-calls');
});

test('openai-chat: captures reasoning_content (deepseek-style)', () => {
  const result = parseChatResponse({
    choices: [{ message: { content: 'answer', reasoning_content: 'let me think...' } }],
  });
  assert.equal(result.content, 'answer');
  assert.equal(result.reasoning, 'let me think...');
});

test('openai-chat: streaming chunks accumulate content, reasoning, and tool calls', () => {
  const acc = {
    content: '',
    reasoning: '',
    toolCalls: [] as { id: string; name: string; arguments: string }[],
    finishReason: undefined,
    rawFinishReason: undefined,
  };
  const deltas = [
    applyStreamChunk({ choices: [{ delta: { reasoning_content: 'think' } }] }, acc),
    applyStreamChunk({ choices: [{ delta: { content: 'Hel' } }] }, acc),
    applyStreamChunk({ choices: [{ delta: { content: 'lo' } }] }, acc),
    applyStreamChunk(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ec', arguments: '{"a"' } }] } }] },
      acc,
    ),
    applyStreamChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ho', arguments: ':1}' } }] } }] }, acc),
    applyStreamChunk({ choices: [{ finish_reason: 'length', delta: {} }] }, acc),
  ];
  assert.equal(acc.content, 'Hello');
  assert.equal(acc.reasoning, 'think');
  assert.equal(acc.toolCalls[0].id, 'c1');
  assert.equal(acc.toolCalls[0].name, 'echo'); // name fragments joined
  assert.equal(acc.toolCalls[0].arguments, '{"a":1}'); // arg fragments joined
  assert.equal(deltas[1].content, 'Hel'); // per-chunk delta returned for live streaming
  assert.deepEqual(deltas[3].toolInputStart, { id: 'c1', name: 'ec' });
  assert.deepEqual(deltas[3].toolInputDelta, { id: 'c1', name: 'ec', delta: '{"a"' });
  assert.deepEqual(deltas[4].toolInputDelta, { id: 'c1', name: 'echo', delta: ':1}' });
  assert.equal(acc.finishReason, 'length');
  assert.equal(acc.rawFinishReason, 'length');
});

test('anthropic: system field + tool_use / tool_result blocks', () => {
  const req = buildAnthropicRequest(CONVO, TOOLS, { model: 'claude-x', maxTokens: 100 });
  assert.equal(req.system, 'be brief');
  assert.equal(req.tools?.[0].input_schema && typeof req.tools[0].input_schema, 'object');
  const assistant = req.messages.find((m) => m.role === 'assistant')!;
  assert.equal(assistant.content[0].type, 'tool_use');
  // tool result merged into a trailing user message
  const lastUser = req.messages[req.messages.length - 1];
  assert.equal(lastUser.content[0].type, 'tool_result');
});

test('anthropic: maps image parts to base64 image blocks', () => {
  const req = buildAnthropicRequest([IMAGE_MESSAGE], [], { model: 'claude-x', maxTokens: 100 });
  const user = req.messages[0];
  assert.deepEqual(user.content.map((part) => part.type), ['text', 'image']);
  const image = user.content[1] as { type: 'image'; source: { media_type: string; data: string } };
  assert.equal(image.source.media_type, 'image/png');
  assert.equal(image.source.data, 'aW1n');
});

test('anthropic: parses text + tool_use', () => {
  const result = parseAnthropicResponse({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'tu_1', name: 'echo', input: { text: 'x' } },
    ],
  });
  assert.equal(result.content, 'hi');
  assert.equal(result.toolCalls[0].id, 'tu_1');
  assert.equal(result.toolCalls[0].arguments, '{"text":"x"}');
  assert.equal(result.finishReason, 'tool-calls');
  assert.equal(result.rawFinishReason, 'tool_use');
});

test('mock provider: calls glob then finalizes on tool result', async () => {
  const p = createMockProvider();
  const first = await p.complete([{ role: 'user', content: 'glob **/*.ts' }], TOOLS);
  assert.equal(first.toolCalls[0].name, 'glob');
  const second = await p.complete(
    [{ role: 'user', content: 'glob **/*.ts' }, { role: 'tool', content: 'a.ts', toolCallId: 'x' }],
    TOOLS,
  );
  assert.equal(second.toolCalls.length, 0);
  assert.match(second.content!, /a\.ts/);
});
