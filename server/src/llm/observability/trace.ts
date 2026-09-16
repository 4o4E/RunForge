import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { config } from '../../config.js';
import type { ProviderAttemptErrorKind } from './repository.js';

const TRACE_FILE_RE = /^provider-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface ProviderTraceRecord {
  invocationId: string;
  attemptId: string;
  attempt: number;
  tenantId: string;
  spaceId: string;
  threadId: string;
  runId: string;
  stepId: string | null;
  purpose: string;
  provider: string;
  model: string;
  url: string;
  requestBody: unknown;
  httpStatus: number | null;
  providerResponseId: string | null;
  rawStream: string | null;
  normalizedResponse: unknown | null;
  finishReason: string | null;
  usage: unknown | null;
  status: 'success' | 'error';
  errorKind: ProviderAttemptErrorKind | null;
  error: string | null;
  retryScheduled: boolean;
  startedAt: string;
  endedAt: string;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** JSONL trace 不写请求头；每行是一整个 HTTP attempt，便于本地按 run/invocation 检索。 */
export class ProviderTraceWriter {
  private queue: Promise<void> = Promise.resolve();
  private cleanedDate = '';

  constructor(
    readonly directory: string,
    private readonly retentionDays = 7,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(record: ProviderTraceRecord): Promise<void> {
    const task = this.queue.then(async () => {
      const now = this.now();
      await mkdir(this.directory, { recursive: true });
      const today = utcDate(now);
      if (this.cleanedDate !== today) {
        await this.cleanup(now);
        this.cleanedDate = today;
      }
      await appendFile(join(this.directory, `provider-${today}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async cleanup(now = this.now()): Promise<void> {
    const cutoff = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - (this.retentionDays - 1),
    ));
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const match = TRACE_FILE_RE.exec(basename(entry.name));
      if (!match) return;
      const fileDate = new Date(`${match[1]}T00:00:00.000Z`);
      if (fileDate < cutoff) await rm(join(this.directory, entry.name), { force: true });
    }));
  }
}

export const providerTraceWriter = new ProviderTraceWriter(
  resolve(config.providerTrace.directory),
  config.providerTrace.retentionDays,
);
