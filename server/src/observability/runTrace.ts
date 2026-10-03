import { mkdir, open, readdir, rm, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import type { AgentEvent } from '../agent/types.js';
import { sanitizeMediaPayloads } from '../llm/observability/mediaPayload.js';

const TRACE_DATE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const RUN_ID_RE = /^[0-9A-Za-z_-]+$/;
const FLUSH_INTERVAL_MS = 250;
const FLUSH_BYTES = 64 * 1024;

interface TraceBufferOptions {
  maxBytes?: number;
  maxRecords?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

interface PendingFile {
  lines: Buffer[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  queue: Promise<void>;
  writing: boolean;
  retryDelay: number;
  batch: { data: Buffer; records: number; position: number | null; written: number } | null;
}

export interface AgentEventTraceRecord {
  kind: 'agent_event';
  recordedAt: string;
  runId: string;
  stepId: string | null;
  event: AgentEvent;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Trace 只写本地文件，不参与业务恢复。每个 run 每个 UTC 自然日一个 JSONL，跨天自动换文件。
 * write() 只确认记录进入内存队列；磁盘错误由 writer 报告，退出时 flushAll() 返回写入错误。
 * 容量包含正在写入的批次，超限只丢弃新日志；每个目录只能由一个 writer 写入。
 */
export class RunTraceWriter {
  private readonly files = new Map<string, PendingFile>();
  private cleanedDate = '';
  private bufferedBytes = 0;
  private bufferedRecords = 0;
  private droppedRecords = 0;
  private lastOverflowReport = -Infinity;
  private readonly limits: Required<TraceBufferOptions>;

  constructor(
    readonly directory: string,
    private readonly retentionDays = 30,
    private readonly now: () => Date = () => new Date(),
    private readonly reportError: (error: unknown) => void = (error) => {
      console.error(`写入 run trace 失败：${(error as Error).message}`);
    },
    options: TraceBufferOptions = {},
  ) {
    this.limits = {
      maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
      maxRecords: options.maxRecords ?? 100_000,
      retryDelayMs: options.retryDelayMs ?? 1_000,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
    };
  }

  async write(runId: string, record: unknown): Promise<void> {
    if (!RUN_ID_RE.test(runId)) throw new Error(`trace runId 无效：${runId}`);
    const now = this.now();
    const path = join(this.directory, runId, `${utcDate(now)}.jsonl`);
    const line = Buffer.from(`${JSON.stringify(sanitizeMediaPayloads(record))}\n`);
    if (this.bufferedBytes + line.length > this.limits.maxBytes || this.bufferedRecords >= this.limits.maxRecords) {
      this.droppedRecords += 1;
      // 连续超限合并告警，避免日志输出本身放大磁盘故障。
      if (Date.now() - this.lastOverflowReport >= 30_000) this.reportOverflow();
      return;
    }
    let pending = this.files.get(path);
    if (!pending) {
      pending = { lines: [], bytes: 0, timer: null, queue: Promise.resolve(), writing: false, retryDelay: 0, batch: null };
      this.files.set(path, pending);
    }
    pending.lines.push(line);
    pending.bytes += line.length;
    this.bufferedBytes += line.length;
    this.bufferedRecords += 1;
    if (!pending.writing && !pending.retryDelay) {
      if (pending.bytes >= FLUSH_BYTES) void this.flushPath(path).catch(() => {});
      else this.schedule(path, pending, FLUSH_INTERVAL_MS);
    }
    if (this.cleanedDate !== utcDate(now)) {
      this.cleanedDate = utcDate(now);
      void this.cleanup(now).catch((error) => console.warn(`清理 run trace 失败：${(error as Error).message}`));
    }
  }

  writeAgentEvent(runId: string, stepId: string | null, event: AgentEvent): Promise<void> {
    return this.write(runId, {
      kind: 'agent_event',
      recordedAt: this.now().toISOString(),
      runId,
      stepId,
      event,
    } satisfies AgentEventTraceRecord);
  }

  async flushRun(runId: string): Promise<void> {
    const runDirectory = join(this.directory, runId);
    while (true) {
      const paths = [...this.files.keys()].filter((path) => dirname(path) === runDirectory);
      if (!paths.length) return;
      await Promise.all(paths.map((path) => this.flushPath(path)));
    }
  }

  async flushAll(): Promise<void> {
    if (this.droppedRecords) this.reportOverflow();
    while (this.files.size) {
      const results = await Promise.allSettled([...this.files.keys()].map((path) => this.flushPath(path)));
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, '排空 run trace 失败，仍有日志未写入');
    }
  }

  private reportOverflow(): void {
    this.reportError(new Error(`run trace 缓冲超限，已丢弃 ${this.droppedRecords} 条新日志；上限 ${this.limits.maxBytes} 字节 / ${this.limits.maxRecords} 条，业务继续运行`));
    this.droppedRecords = 0;
    this.lastOverflowReport = Date.now();
  }

  private schedule(path: string, pending: PendingFile, delay: number): void {
    if (pending.timer) return;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      // flushPath 负责告警和安排重试，后台定时器不向业务传播磁盘错误。
      void this.flushPath(path).catch(() => {});
    }, delay);
    pending.timer.unref();
  }

  private async flushPath(path: string): Promise<void> {
    const pending = this.files.get(path);
    if (!pending) return;
    if (pending.writing) return pending.queue;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    pending.writing = true;
    let task: Promise<void>;
    task = (async () => {
      while (pending.batch || pending.lines.length) {
        if (!pending.batch) {
          pending.batch = { data: Buffer.concat(pending.lines, pending.bytes), records: pending.lines.length, position: null, written: 0 };
          pending.lines = [];
          pending.bytes = 0;
        }
        const batch = pending.batch;
        await mkdir(dirname(path), { recursive: true });
        const file = await open(path, constants.O_CREAT | constants.O_RDWR);
        try {
          batch.position ??= (await file.stat()).size;
          // 固定批次的文件位置：部分写入后重试覆盖未确认部分，不重复追加半条 JSON。
          while (batch.written < batch.data.length) {
            const { bytesWritten } = await file.write(batch.data, batch.written, batch.data.length - batch.written, batch.position + batch.written);
            if (!bytesWritten) throw new Error(`run trace 文件写入没有进展：${path}`);
            batch.written += bytesWritten;
          }
        } finally {
          await file.close();
        }
        this.bufferedBytes -= batch.data.length;
        this.bufferedRecords -= batch.records;
        pending.batch = null;
        pending.retryDelay = 0;
      }
    })().catch((error: unknown) => {
      pending.retryDelay = Math.min(pending.retryDelay ? pending.retryDelay * 2 : this.limits.retryDelayMs, this.limits.maxRetryDelayMs);
      this.reportError(new Error(`run trace 写入失败，${pending.retryDelay} 毫秒后重试：${path}；${(error as Error).message}`, { cause: error }));
      throw error;
    }).finally(() => {
      pending.writing = false;
      if (pending.batch || pending.lines.length) this.schedule(path, pending, pending.retryDelay);
      else if (this.files.get(path) === pending && pending.queue === task) {
        this.files.delete(path);
        if (this.droppedRecords) this.reportOverflow();
      }
    });
    pending.queue = task;
    await task;
  }

  async cleanup(now = this.now()): Promise<void> {
    const cutoff = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - (this.retentionDays - 1),
    ));
    const runDirectories = await readdir(this.directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(runDirectories.map(async (runEntry) => {
      if (!runEntry.isDirectory() || !RUN_ID_RE.test(runEntry.name)) return;
      const runDirectory = join(this.directory, runEntry.name);
      const files = await readdir(runDirectory, { withFileTypes: true }).catch(() => []);
      await Promise.all(files.map(async (entry) => {
        if (!entry.isFile()) return;
        const match = TRACE_DATE_RE.exec(basename(entry.name));
        if (!match) return;
        const fileDate = new Date(`${match[1]}T00:00:00.000Z`);
        const path = join(runDirectory, entry.name);
        if (fileDate < cutoff && !this.files.has(path)) await rm(path, { force: true });
      }));
      const remaining = await readdir(runDirectory).catch(() => []);
      if (!remaining.length) await rmdir(runDirectory).catch(() => {});
    }));
  }
}

export const runTraceWriter = new RunTraceWriter(
  resolve(config.trace.directory),
  config.trace.retentionDays,
);

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startTraceRetention(): void {
  if (cleanupTimer) return;
  void runTraceWriter.cleanup().catch((error) => console.warn(`清理 run trace 失败：${(error as Error).message}`));
  cleanupTimer = setInterval(() => {
    void runTraceWriter.cleanup().catch((error) => console.warn(`清理 run trace 失败：${(error as Error).message}`));
  }, 24 * 60 * 60 * 1000);
  cleanupTimer.unref?.();
}

export function stopTraceRetention(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
