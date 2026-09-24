import { prisma } from '../../db/prisma.js';
import { newProviderAttemptId, newProviderInvocationId } from '../../id.js';
import { nullableJson, requiredJson } from '../../store/prismaRows.js';
import { sanitizeMediaPayloads } from './mediaPayload.js';

export type ProviderRecordStatus = 'running' | 'success' | 'error';
export type ProviderAttemptErrorKind = 'http' | 'transport' | 'parse' | 'runtime';

export interface ProviderInvocationRecord {
  id: string;
  tenantId: string;
  spaceId: string;
  threadId: string;
  runId: string;
  stepId: string | null;
  purpose: string;
  provider: string;
  model: string;
  logicalRequest: unknown;
  normalizedResponse: unknown | null;
  status: ProviderRecordStatus;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ProviderAttemptRecord {
  id: string;
  invocationId: string;
  attempt: number;
  url: string;
  requestBody: unknown;
  httpStatus: number | null;
  providerResponseId: string | null;
  rawStream: string | null;
  normalizedResponse: unknown | null;
  finishReason: string | null;
  usage: unknown | null;
  status: ProviderRecordStatus;
  errorKind: ProviderAttemptErrorKind | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ProviderObservationRepository {
  createInvocation(input: Omit<ProviderInvocationRecord, 'id' | 'normalizedResponse' | 'status' | 'error' | 'endedAt'>): Promise<string>;
  finishInvocation(
    id: string,
    input: Pick<ProviderInvocationRecord, 'status' | 'normalizedResponse' | 'error' | 'endedAt'>,
  ): Promise<void>;
  createAttempt(input: Omit<ProviderAttemptRecord, 'id' | 'httpStatus' | 'providerResponseId' | 'rawStream' | 'normalizedResponse' | 'finishReason' | 'usage' | 'status' | 'errorKind' | 'error' | 'endedAt'>): Promise<string>;
  finishAttempt(
    id: string,
    input: Pick<ProviderAttemptRecord, 'httpStatus' | 'providerResponseId' | 'rawStream' | 'normalizedResponse' | 'finishReason' | 'usage' | 'status' | 'errorKind' | 'error' | 'endedAt'>,
  ): Promise<void>;
}

export class PrismaProviderObservationRepository implements ProviderObservationRepository {
  async createInvocation(
    input: Omit<ProviderInvocationRecord, 'id' | 'normalizedResponse' | 'status' | 'error' | 'endedAt'>,
  ): Promise<string> {
    const id = newProviderInvocationId();
    await prisma.provider_invocations.create({
      data: {
        id,
        tenant_id: input.tenantId,
        space_id: input.spaceId,
        thread_id: input.threadId,
        run_id: input.runId,
        step_id: input.stepId,
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        logical_request: requiredJson(sanitizeMediaPayloads(input.logicalRequest)),
        started_at: new Date(input.startedAt),
      },
    });
    return id;
  }

  async finishInvocation(
    id: string,
    input: Pick<ProviderInvocationRecord, 'status' | 'normalizedResponse' | 'error' | 'endedAt'>,
  ): Promise<void> {
    await prisma.provider_invocations.update({
      where: { id },
      data: {
        status: input.status,
        normalized_response: nullableJson(sanitizeMediaPayloads(input.normalizedResponse)),
        error: input.error,
        ended_at: input.endedAt ? new Date(input.endedAt) : null,
      },
    });
  }

  async createAttempt(
    input: Omit<ProviderAttemptRecord, 'id' | 'httpStatus' | 'providerResponseId' | 'rawStream' | 'normalizedResponse' | 'finishReason' | 'usage' | 'status' | 'errorKind' | 'error' | 'endedAt'>,
  ): Promise<string> {
    const id = newProviderAttemptId();
    await prisma.provider_attempts.create({
      data: {
        id,
        invocation_id: input.invocationId,
        attempt: input.attempt,
        url: input.url,
        request_body: requiredJson(sanitizeMediaPayloads(input.requestBody)),
        started_at: new Date(input.startedAt),
      },
    });
    return id;
  }

  async finishAttempt(
    id: string,
    input: Pick<ProviderAttemptRecord, 'httpStatus' | 'providerResponseId' | 'rawStream' | 'normalizedResponse' | 'finishReason' | 'usage' | 'status' | 'errorKind' | 'error' | 'endedAt'>,
  ): Promise<void> {
    await prisma.provider_attempts.update({
      where: { id },
      data: {
        http_status: input.httpStatus,
        provider_response_id: input.providerResponseId,
        raw_stream: input.rawStream == null ? null : String(sanitizeMediaPayloads(input.rawStream)),
        normalized_response: nullableJson(sanitizeMediaPayloads(input.normalizedResponse)),
        finish_reason: input.finishReason,
        usage: nullableJson(input.usage),
        status: input.status,
        error_kind: input.errorKind,
        error: input.error == null ? null : String(sanitizeMediaPayloads(input.error)),
        ended_at: input.endedAt ? new Date(input.endedAt) : null,
      },
    });
  }
}

/** 离线测试也使用真实状态转换，避免用 no-op 掩盖 invocation/attempt 生命周期错误。 */
export class MemoryProviderObservationRepository implements ProviderObservationRepository {
  readonly invocations = new Map<string, ProviderInvocationRecord>();
  readonly attempts = new Map<string, ProviderAttemptRecord>();

  async createInvocation(
    input: Omit<ProviderInvocationRecord, 'id' | 'normalizedResponse' | 'status' | 'error' | 'endedAt'>,
  ): Promise<string> {
    const id = newProviderInvocationId();
    this.invocations.set(id, {
      ...structuredClone({ ...input, logicalRequest: sanitizeMediaPayloads(input.logicalRequest) }),
      id,
      normalizedResponse: null,
      status: 'running',
      error: null,
      endedAt: null,
    });
    return id;
  }

  async finishInvocation(
    id: string,
    input: Pick<ProviderInvocationRecord, 'status' | 'normalizedResponse' | 'error' | 'endedAt'>,
  ): Promise<void> {
    const current = this.invocations.get(id);
    if (!current) throw new Error(`Provider invocation 不存在：${id}`);
    this.invocations.set(id, { ...current, ...structuredClone({
      ...input,
      normalizedResponse: sanitizeMediaPayloads(input.normalizedResponse),
    }) });
  }

  async createAttempt(
    input: Omit<ProviderAttemptRecord, 'id' | 'httpStatus' | 'providerResponseId' | 'rawStream' | 'normalizedResponse' | 'finishReason' | 'usage' | 'status' | 'errorKind' | 'error' | 'endedAt'>,
  ): Promise<string> {
    const duplicate = [...this.attempts.values()].some(
      (attempt) => attempt.invocationId === input.invocationId && attempt.attempt === input.attempt,
    );
    if (duplicate) throw new Error(`Provider attempt 序号重复：${input.invocationId}/${input.attempt}`);
    const id = newProviderAttemptId();
    this.attempts.set(id, {
      ...structuredClone({ ...input, requestBody: sanitizeMediaPayloads(input.requestBody) }),
      id,
      httpStatus: null,
      providerResponseId: null,
      rawStream: null,
      normalizedResponse: null,
      finishReason: null,
      usage: null,
      status: 'running',
      errorKind: null,
      error: null,
      endedAt: null,
    });
    return id;
  }

  async finishAttempt(
    id: string,
    input: Pick<ProviderAttemptRecord, 'httpStatus' | 'providerResponseId' | 'rawStream' | 'normalizedResponse' | 'finishReason' | 'usage' | 'status' | 'errorKind' | 'error' | 'endedAt'>,
  ): Promise<void> {
    const current = this.attempts.get(id);
    if (!current) throw new Error(`Provider attempt 不存在：${id}`);
    this.attempts.set(id, { ...current, ...structuredClone({
      ...input,
      rawStream: input.rawStream == null ? null : String(sanitizeMediaPayloads(input.rawStream)),
      normalizedResponse: sanitizeMediaPayloads(input.normalizedResponse),
      error: input.error == null ? null : String(sanitizeMediaPayloads(input.error)),
    }) });
  }
}

export const providerObservationRepository: ProviderObservationRepository = process.env.STORE === 'memory'
  ? new MemoryProviderObservationRepository()
  : new PrismaProviderObservationRepository();
