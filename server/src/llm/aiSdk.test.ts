import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiSdkProvider, providerStateFromResponseMessages, toModelMessages } from './providers/aiSdk.js';
import type { ModelMessage } from 'ai';
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

test('AI SDK provider state: encrypted reasoning survives response extraction and prompt replay', () => {
  const providerOptions = {
    openai: { itemId: 'rs_1', reasoningEncryptedContent: 'encrypted-reasoning' },
  };
  const state = providerStateFromResponseMessages([
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', providerOptions },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: { text: 'hi' } },
      ],
    },
  ] as ModelMessage[]);
  assert.equal(state?.reasoningParts?.[0].providerOptions?.openai.reasoningEncryptedContent, 'encrypted-reasoning');

  const replay = toModelMessages([{
    role: 'assistant',
    content: null,
    providerState: state,
    toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hi"}' }],
  }]);
  const parts = replay[0].content as Array<{ type: string; providerOptions?: typeof providerOptions }>;
  assert.deepEqual(parts.map((part) => part.type), ['reasoning', 'tool-call']);
  assert.equal(parts[0].providerOptions?.openai.reasoningEncryptedContent, 'encrypted-reasoning');
});

test('toModelMessages: maps user image parts', () => {
  const out = toModelMessages([
    {
      role: 'user',
      content: 'look',
      contentParts: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png', path: 'photo.png' },
      ],
    },
  ]);
  const parts = out[0].content as Array<{ type: string; image?: string; mediaType?: string }>;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image']);
  assert.equal(parts[1].image, 'aW1n');
  assert.equal(parts[1].mediaType, 'image/png');
});

test('toModelMessages: decodes string-wrapped tool-call object args', () => {
  const out = toModelMessages([
    { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'shell', arguments: JSON.stringify('{"command":"ls"}') }] },
  ]);
  const parts = out[0].content as Array<{ type: string; input?: unknown }>;
  assert.deepEqual(parts.map((p) => p.type), ['tool-call']);
  assert.deepEqual(parts[0].input, { command: 'ls' });
});

test('toModelMessages: malformed tool-call args stay visible to the model', () => {
  const out = toModelMessages([
    { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'shell', arguments: 'not json' }] },
  ]);
  const parts = out[0].content as Array<{ type: string; input?: unknown }>;
  // No leading text part (content was null); just the tool-call.
  assert.deepEqual(parts.map((p) => p.type), ['tool-call']);
  assert.deepEqual((parts[0].input as Record<string, unknown>)._invalidToolArguments, true);
});

test('AI SDK provider: configured streaming also applies to complete()', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = '';
  let calls = 0;
  const observingFetch: typeof fetch = async (input, init) => {
    calls += 1;
    const request = input instanceof Request ? input : new Request(input, init);
    requestBody = await request.text();
    return new Response(JSON.stringify({ error: { message: 'expected test failure' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.fetch = async () => assert.fail('显式注入 fetch 时不应使用全局 fetch');

  try {
    const provider = createAiSdkProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: null,
      timeoutMs: 1_000,
      retries: 0,
      stream: true,
    }, { protocol: 'openai-responses' });

    await assert.rejects(provider.complete(
      [{ role: 'user', content: '你好' }],
      [],
      { fetch: observingFetch },
    ));
    assert.equal(calls, 1);
    const body = JSON.parse(requestBody);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal('max_output_tokens' in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
