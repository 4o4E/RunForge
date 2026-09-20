import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LlmResult, Provider } from './types.js';
import { ProviderRunner, type ProviderInvocationContext } from './providerRunner.js';
import { MemoryProviderObservationRepository } from './observability/repository.js';
import { ProviderTraceWriter, type ProviderTraceRecord } from './observability/trace.js';

const context: ProviderInvocationContext = {
  tenantId: 'tn_provider_runner',
  spaceId: 'sp_provider_runner',
  threadId: 'th_provider_runner',
  runId: 'ru_provider_runner',
  stepId: 'st_provider_runner',
  purpose: 'agent',
  provider: 'fake',
  model: 'fake-model',
  retries: 1,
};

function result(content: string): LlmResult {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 3, outputTokens: 2 },
    finishReason: 'stop',
    rawFinishReason: 'stop',
  };
}

test('ProviderRunner: 由 RunForge 重试并保存每个真实 HTTP attempt', async () => {
  const repository = new MemoryProviderObservationRepository();
  const traceDir = await mkdtemp(join(tmpdir(), 'runforge-provider-trace-'));
  const trace = new ProviderTraceWriter(traceDir);
  const delays: number[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'busy' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
      });
    }
    return new Response(JSON.stringify({ id: 'resp_2', answer: 'done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider: Provider = {
    name: 'fake',
    async completeStream(_messages, _tools, _onDelta, options) {
      const response = await options!.fetch!(
        'https://provider.test/v1/chat?api_key=must-not-persist&key=also-must-not-persist&model=fake-model',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer must-not-persist', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hello' }] }),
        },
      );
      const body = await response.json() as { answer?: string };
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`) as Error & { statusCode: number };
        error.statusCode = response.status;
        throw error;
      }
      return result(body.answer ?? '');
    },
  };
  const runner = new ProviderRunner(
    repository,
    trace,
    async (delay) => { delays.push(delay); },
    () => 0,
    fetcher,
  );

  const output = await runner.run({
    provider,
    context,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  });
  assert.equal(output.content, 'done');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [800]);

  const invocations = [...repository.invocations.values()];
  const attempts = [...repository.attempts.values()].sort((a, b) => a.attempt - b.attempt);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].status, 'success');
  assert.equal(invocations[0].purpose, 'agent');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ['error', 'success']);
  assert.deepEqual(attempts.map((attempt) => attempt.errorKind), ['http', null]);
  assert.deepEqual(attempts.map((attempt) => attempt.httpStatus), [503, 200]);
  assert.equal(attempts[0].providerResponseId, 'req_1');
  assert.equal(attempts[1].providerResponseId, 'resp_2');
  assert.equal(attempts[0].url.includes('must-not-persist'), false);
  assert.equal(attempts[0].url.includes('also-must-not-persist'), false);
  assert.equal(new URL(attempts[0].url).searchParams.get('model'), 'fake-model');
  assert.deepEqual(attempts[1].requestBody, {
    model: 'fake-model',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.match(attempts[0].rawStream ?? '', /busy/);
  assert.equal(JSON.stringify(attempts).includes('Bearer must-not-persist'), false);

  const traceFiles = await readdir(traceDir);
  const lines = (await readFile(join(traceDir, traceFiles[0]), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as ProviderTraceRecord);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].retryScheduled, true);
  assert.equal(lines[1].status, 'success');
  assert.equal(JSON.stringify(lines).includes('Bearer must-not-persist'), false);
});

test('ProviderRunner: 已向 runtime 发布流式增量后不重试', async () => {
  const repository = new MemoryProviderObservationRepository();
  let calls = 0;
  const provider: Provider = {
    name: 'fake-stream',
    async completeStream(_messages, _tools, onDelta, options) {
      calls += 1;
      const response = await options!.fetch!('https://provider.test/v1/chat', {
        method: 'POST',
        body: JSON.stringify({ stream: true }),
      });
      await response.text();
      onDelta({ content: 'partial' });
      const error = new Error('network terminated') as Error & { retryable: boolean };
      error.retryable = true;
      throw error;
    },
  };
  const runner = new ProviderRunner(
    repository,
    null,
    async () => assert.fail('不应进入重试退避'),
    () => 0,
    async () => new Response('data: partial\n\n', { status: 200 }),
  );
  const deltas: string[] = [];
  await assert.rejects(runner.run({
    provider,
    context,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    onDelta: (delta) => { if (delta.content) deltas.push(delta.content); },
  }), /network terminated/);
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ['partial']);
  assert.equal([...repository.attempts.values()][0].status, 'error');
  assert.equal([...repository.attempts.values()][0].errorKind, 'transport');
  assert.equal([...repository.invocations.values()][0].status, 'error');
});

test('ProviderRunner: 业务取消会立即中止当前请求且不会重试', async () => {
  const repository = new MemoryProviderObservationRepository();
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const provider: Provider = {
    name: 'fake-cancel',
    async completeStream(_messages, _tools, _onDelta, options) {
      calls += 1;
      const signal = options?.abortSignal;
      assert.ok(signal);
      started();
      return new Promise<LlmResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const runner = new ProviderRunner(
    repository,
    null,
    async () => assert.fail('业务取消后不应重试'),
    () => 0,
  );
  const running = runner.run({
    provider,
    context: { ...context, retries: 3 },
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    abortSignal: controller.signal,
  });
  await requestStarted;
  controller.abort(new Error('resource deleted'));
  await assert.rejects(running, /resource deleted/);
  assert.equal(calls, 1);
  assert.equal([...repository.invocations.values()][0].status, 'error');
});

test('ProviderRunner: 保存响应解析错误且不把它当成可重试传输错误', async () => {
  const repository = new MemoryProviderObservationRepository();
  let calls = 0;
  const provider: Provider = {
    name: 'fake-json',
    async completeStream(_messages, _tools, _onDelta, options) {
      calls += 1;
      const response = await options!.fetch!('https://provider.test/v1/chat', {
        method: 'POST',
        body: '{}',
      });
      await response.json();
      return result('unreachable');
    },
  };
  const runner = new ProviderRunner(
    repository,
    null,
    async () => assert.fail('解析错误不应重试'),
    () => 0,
    async () => new Response('{invalid json', { status: 200 }),
  );
  await assert.rejects(runner.run({
    provider,
    context,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  }));
  assert.equal(calls, 1);
  const attempt = [...repository.attempts.values()][0];
  assert.equal(attempt.errorKind, 'parse');
  assert.equal(attempt.rawStream, '{invalid json');
});

test('ProviderTraceWriter: 只清理七日窗口之外的 provider trace', async () => {
  const traceDir = await mkdtemp(join(tmpdir(), 'runforge-provider-retention-'));
  await writeFile(join(traceDir, 'provider-2026-09-09.jsonl'), '{}\n');
  await writeFile(join(traceDir, 'provider-2026-09-10.jsonl'), '{}\n');
  await writeFile(join(traceDir, 'keep.txt'), 'keep');
  const now = () => new Date('2026-09-16T08:00:00.000Z');
  const writer = new ProviderTraceWriter(traceDir, 7, now);
  await writer.write({
    invocationId: 'pi_1',
    attemptId: 'pa_1',
    attempt: 1,
    ...context,
    url: 'https://provider.test/v1/chat',
    requestBody: {},
    httpStatus: 200,
    providerResponseId: null,
    rawStream: '{}',
    normalizedResponse: {},
    finishReason: 'stop',
    usage: null,
    status: 'success',
    errorKind: null,
    error: null,
    retryScheduled: false,
    startedAt: now().toISOString(),
    endedAt: now().toISOString(),
  });
  const files = (await readdir(traceDir)).sort();
  assert.deepEqual(files, [
    'keep.txt',
    'provider-2026-09-10.jsonl',
    'provider-2026-09-16.jsonl',
  ]);
});
