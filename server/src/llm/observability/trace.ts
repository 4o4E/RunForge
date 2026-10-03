import { resolve } from 'node:path';
import { config } from '../../config.js';
import type { ProviderAttemptErrorKind } from './repository.js';
import { RunTraceWriter, runTraceWriter } from '../../observability/runTrace.js';

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

/** Provider attempt 与 Agent 流式事件共用按 run/自然日分片的本地 trace。 */
export class ProviderTraceWriter {
  constructor(
    readonly directory: string,
    retentionDays = 30,
    now: () => Date = () => new Date(),
    private readonly writer: RunTraceWriter = new RunTraceWriter(directory, retentionDays, now),
  ) {
  }

  async write(record: ProviderTraceRecord): Promise<void> {
    await this.writer.write(record.runId, { kind: 'provider_attempt', ...record });
  }

  async cleanup(now?: Date): Promise<void> {
    await this.writer.flushAll();
    await this.writer.cleanup(now);
  }
}

export const providerTraceWriter = new ProviderTraceWriter(
  resolve(config.trace.directory),
  config.trace.retentionDays,
  () => new Date(),
  runTraceWriter,
);
