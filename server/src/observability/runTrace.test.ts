import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { RunTraceWriter } from './runTrace.js';

async function waitForTrace(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const actual = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
      throw error;
    });
    if (actual === expected) return;
    await delay(10);
  }
  assert.equal(await readFile(path, 'utf8'), expected);
}

test('RunTraceWriter: 真实目录故障恢复后自动重试，保留入队日期与记录顺序', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-trace-retry-'));
  const directory = join(root, 'logs');
  await writeFile(directory, '阻止创建日志目录');
  let clock = new Date('2026-10-01T23:59:59Z');
  const errors: unknown[] = [];
  const writer = new RunTraceWriter(directory, 30, () => clock, (error) => errors.push(error), { retryDelayMs: 30, maxRetryDelayMs: 60 });
  try {
    await writer.write('ru_retry', { text: '第一条' });
    await assert.rejects(writer.flushAll(), AggregateError);
    await writer.write('ru_retry', { text: '第二条' });
    clock = new Date('2026-10-02T00:00:01Z');
    await rm(directory);
    // 恢复目录之后不再调用 write/flush，等待真正的后台重试。
    await waitForTrace(join(directory, 'ru_retry', '2026-10-01.jsonl'), '{"text":"第一条"}\n{"text":"第二条"}\n');
    await writer.flushAll();
    assert.ok(errors.some((error) => error instanceof Error && error.message.includes('重试')));
    assert.deepEqual(await readdir(join(directory, 'ru_retry')), ['2026-10-01.jsonl']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RunTraceWriter: 全局字节限制包含正在写入的记录，超限不影响调用者', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-trace-capacity-'));
  const clock = new Date('2026-10-02T00:00:00Z');
  const record = { text: '真实缓冲'.repeat(10_000) };
  const serialized = `${JSON.stringify(record)}\n`;
  const errors: unknown[] = [];
  const writer = new RunTraceWriter(root, 30, () => clock, (error) => errors.push(error), {
    maxBytes: Buffer.byteLength(serialized),
  });
  try {
    // write 会启动真实异步写入，但在第一次磁盘等待完成之前仍占用全部容量。
    await writer.write('ru_first', record);
    for (let index = 0; index < 20; index += 1) await writer.write(`ru_drop_${index}`, { index });
    await writer.flushAll();
    assert.equal(await readFile(join(root, 'ru_first', '2026-10-02.jsonl'), 'utf8'), serialized);
    assert.deepEqual(await readdir(root), ['ru_first']);
    assert.equal(errors.length, 2);
    assert.match(String(errors[0]), /丢弃 1 条新日志/);
    assert.match(String(errors[1]), /丢弃 19 条新日志/);
    await writer.write('ru_after', { text: '释放容量后继续接收' });
    await writer.flushAll();
    assert.match(await readFile(join(root, 'ru_after', '2026-10-02.jsonl'), 'utf8'), /继续接收/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RunTraceWriter: 持续故障限制跨 run 记录数量，显式排空报告错误且恢复后可以再次排空', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-trace-record-limit-'));
  const directory = join(root, 'logs');
  await writeFile(directory, '阻止创建日志目录');
  const errors: unknown[] = [];
  const writer = new RunTraceWriter(directory, 30, () => new Date('2026-10-02T00:00:00Z'), (error) => errors.push(error), {
    maxRecords: 2,
    retryDelayMs: 30,
    maxRetryDelayMs: 60,
  });
  try {
    await writer.write('ru_one', { index: 1 });
    await writer.write('ru_two', { index: 2 });
    await assert.rejects(writer.flushAll(), (error: AggregateError) => error.errors.length === 2);
    for (let index = 0; index < 100; index += 1) await writer.write(`ru_drop_${index}`, { index });
    await delay(100);
    assert.ok(errors.filter((error) => String(error).includes('重试')).length >= 4);
    await assert.rejects(writer.flushAll(), AggregateError);
    await rm(directory);
    await writer.flushAll();
    assert.deepEqual((await readdir(directory)).sort(), ['ru_one', 'ru_two']);
    assert.equal(await readFile(join(directory, 'ru_one', '2026-10-02.jsonl'), 'utf8'), '{"index":1}\n');
    assert.equal(await readFile(join(directory, 'ru_two', '2026-10-02.jsonl'), 'utf8'), '{"index":2}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RunTraceWriter: 单条记录超过容量直接告警丢弃，不保留文件队列', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-trace-oversized-'));
  const errors: unknown[] = [];
  const writer = new RunTraceWriter(root, 30, () => new Date(), (error) => errors.push(error), { maxBytes: 8 });
  try {
    await writer.write('ru_oversized', { text: '超过容量' });
    await writer.flushAll();
    assert.deepEqual(await readdir(root), []);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /缓冲超限/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RunTraceWriter: 真实文件大小限制导致部分写入，恢复后 JSONL 不重复且已有内容不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-trace-partial-'));
  const moduleUrl = new URL('./runTrace.ts', import.meta.url).href;
  // Linux 子进程设置自己的文件大小限制，不修改测试进程或业务容器的资源限制。
  const script = `
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import { readFile, stat } from 'node:fs/promises';
    import { RunTraceWriter } from ${JSON.stringify(moduleUrl)};
    const command = promisify(execFile);
    const errors = [];
    const writer = new RunTraceWriter(${JSON.stringify(root)}, 30, () => new Date('2026-10-02T00:00:00Z'), error => errors.push(error));
    const path = ${JSON.stringify(join(root, 'ru_partial', '2026-10-02.jsonl'))};
    const records = [{ text: '已有完整记录' }, { text: '真实部分写入'.repeat(500) }, { text: '后续记录' }];
    await writer.write('ru_partial', records[0]);
    await writer.flushAll();
    process.on('SIGXFSZ', () => {});
    await command('prlimit', ['--pid', String(process.pid), '--fsize=1024:unlimited']);
    try {
      await writer.write('ru_partial', records[1]);
      await assert.rejects(writer.flushAll(), error => error.errors[0].code === 'EFBIG');
      assert.equal((await stat(path)).size, 1024);
      await writer.write('ru_partial', records[2]);
    } finally {
      await command('prlimit', ['--pid', String(process.pid), '--fsize=unlimited:unlimited']);
    }
    await writer.flushAll();
    assert.deepEqual((await readFile(path, 'utf8')).trim().split('\\n').map(line => JSON.parse(line)), records);
    assert.ok(errors.length >= 1);
  `;
  try {
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), timeout: 10_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RunTraceWriter: 每个 run 按自然日分片并保留三十天', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-run-trace-'));
  let clock = new Date('2026-09-29T23:59:59.000Z');
  const writer = new RunTraceWriter(root, 30, () => clock);

  const first = writer.writeAgentEvent('ru_trace_a', 'st_1', { type: 'llm_delta', step: 1, text: '第一天' });
  await writer.flushRun('ru_trace_a');
  await first;
  clock = new Date('2026-09-30T00:00:01.000Z');
  const second = writer.writeAgentEvent('ru_trace_a', 'st_1', { type: 'llm_delta', step: 1, text: '第二天' });
  const other = writer.writeAgentEvent('ru_trace_b', null, { type: 'error', step: 0, message: '另一个 run' });
  await writer.flushAll();
  await Promise.all([second, other]);

  assert.deepEqual((await readdir(join(root, 'ru_trace_a'))).sort(), ['2026-09-29.jsonl', '2026-09-30.jsonl']);
  assert.deepEqual(await readdir(join(root, 'ru_trace_b')), ['2026-09-30.jsonl']);
  assert.match(await readFile(join(root, 'ru_trace_a', '2026-09-29.jsonl'), 'utf8'), /第一天/);

  clock = new Date('2026-10-29T00:00:00.000Z');
  await writer.cleanup();
  assert.deepEqual(await readdir(join(root, 'ru_trace_a')), ['2026-09-30.jsonl']);
});

test('RunTraceWriter: flushRun 等待同一文件所有并发批次真实写入完成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-run-trace-drain-'));
  const writer = new RunTraceWriter(root);
  const payload = '真实文件写入'.repeat(2_000);
  for (let index = 0; index < 40; index += 1) {
    void writer.writeAgentEvent('ru_trace_batches', 'st_1', {
      type: 'llm_delta',
      step: 1,
      text: `${index}:${payload}`,
    });
  }

  await writer.flushRun('ru_trace_batches');
  const files = await readdir(join(root, 'ru_trace_batches'));
  const records = (await readFile(join(root, 'ru_trace_batches', files[0]!), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: { text: string } });
  assert.equal(records.length, 40);
  assert.deepEqual(records.map(({ event }) => Number(event.text.split(':', 1)[0])), Array.from({ length: 40 }, (_, index) => index));
});

test('RunTraceWriter: SIGTERM 关闭前等待真实文件队列写完', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-run-trace-signal-'));
  const moduleUrl = new URL('./runTrace.ts', import.meta.url).href;
  const script = [
    `import { RunTraceWriter } from ${JSON.stringify(moduleUrl)};`,
    `const writer = new RunTraceWriter(${JSON.stringify(root)});`,
    `await writer.writeAgentEvent('ru_trace_signal', null, { type: 'error', step: 0, message: '关闭前记录' });`,
    `process.once('SIGTERM', async () => { await writer.flushAll(); process.exit(0); });`,
    `process.stdout.write('READY\\n');`,
    `setInterval(() => {}, 1000);`,
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('READY\n')) resolveReady();
    });
    child.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString(); });
    child.once('error', rejectReady);
    child.once('exit', (code, signal) => {
      rejectReady(new Error(`trace 子进程未就绪就退出：${code}/${signal}`));
    });
  });
  await ready;
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];

  assert.equal(code, 0, `trace 子进程 stderr: ${errorOutput}; stdout: ${output}`);
  assert.equal(signal, null);
  const [filename] = await readdir(join(root, 'ru_trace_signal'));
  const trace = await readFile(join(root, 'ru_trace_signal', filename!), 'utf8');
  assert.match(trace, /关闭前记录/);
});
