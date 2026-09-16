import type {
  ExternalCallerSummary,
  ExternalArtifactSummary,
  ExternalArtifactUploadReceipt,
  ExternalCancelReceipt,
  ExternalRunReceipt,
  ExternalRunView,
  ExternalNextStepReceipt,
  ExternalSource,
  ExternalTokenSummary,
  RunStatus,
} from '@runforge/contracts';
import { prisma } from '../db/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  newExternalCallerId,
  newExternalRequestId,
  newExternalTokenId,
  newRunId,
  newRunInputId,
  newThreadId,
} from '../id.js';
import { requiredJson, timestamp, toRunRow, toSpaceRow } from '../store/prismaRows.js';
import { RunActiveError, SpaceConfigChangedError } from '../store/types.js';
import type {
  ExternalAppendRunInput,
  ExternalArtifactCreateInput,
  ExternalCallerAccess,
  ExternalCallerWithTokens,
  ExternalCancelInput,
  ExternalRepository,
  ExternalRunWriteInput,
  ExternalWriteResult,
} from './types.js';
import { ExternalApiError } from './types.js';
import {
  MAX_EXTERNAL_ARTIFACT_BYTES,
  type ExternalArtifactTokenSource,
} from './artifactProtocol.js';

type Transaction = Prisma.TransactionClient;

function callerSummary(row: {
  id: string;
  tenant_id: string;
  space_id: string;
  name: string;
  status: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}): ExternalCallerSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    name: row.name,
    status: row.status as ExternalCallerSummary['status'],
    metadata: row.metadata as Record<string, unknown>,
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
  };
}

function tokenSummary(row: {
  id: string;
  caller_id: string;
  label: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}): ExternalTokenSummary {
  return {
    id: row.id,
    callerId: row.caller_id,
    label: row.label,
    expiresAt: timestamp(row.expires_at),
    revokedAt: timestamp(row.revoked_at),
    lastUsedAt: timestamp(row.last_used_at),
    createdAt: timestamp(row.created_at)!,
  };
}

function artifactSummary(row: {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: bigint;
  status: string;
  metadata: unknown;
  thread_id: string | null;
  run_id: string | null;
  created_at: Date;
  materialized_at: Date | null;
}): ExternalArtifactSummary {
  const size = Number(row.size_bytes);
  if (!Number.isSafeInteger(size)) throw new Error(`artifact 大小超出 JavaScript 安全整数范围：${row.size_bytes}`);
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    size,
    status: row.status as ExternalArtifactSummary['status'],
    metadata: row.metadata as Record<string, unknown>,
    threadId: row.thread_id,
    runId: row.run_id,
    createdAt: timestamp(row.created_at)!,
    materializedAt: timestamp(row.materialized_at),
  };
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function jsonResponse<T>(value: unknown): T {
  return value as T;
}

function isUniqueConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'P2002';
}

async function occupiedRunError(tx: Transaction, threadId: string): Promise<Error> {
  const thread = await tx.threads.findUnique({
    where: { id: threadId },
    select: {
      executing_run_id: true,
      runs_threads_executing_run_idToruns: { select: { status: true } },
    },
  });
  if (thread?.executing_run_id) {
    return new RunActiveError(
      thread.executing_run_id,
      (thread.runs_threads_executing_run_idToruns?.status as RunStatus | undefined) ?? 'running',
    );
  }
  return new ExternalApiError(409, 'THREAD_STATE_CHANGED', 'thread 状态已变化，请重试');
}

function requestSource(input: { source: ExternalSource }): Prisma.InputJsonValue {
  return requiredJson(input.source) as Prisma.InputJsonValue;
}

async function requireLiveAccess(tx: Transaction, access: ExternalCallerAccess, requireExecutionUser: boolean) {
  const token = await tx.external_tokens.findFirst({
    where: {
      id: access.token.id,
      token_hash: { not: '' },
      revoked_at: null,
      OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      external_callers: {
        id: access.caller.id,
        tenant_id: access.caller.tenantId,
        space_id: access.caller.spaceId,
        status: 'active',
        tenants: { status: 'active' },
        spaces: { mode: 'external', deleted_at: null },
      },
    },
    select: {
      external_callers: {
        select: {
          spaces: { select: { config_version: true, execution_user_id: true } },
        },
      },
    },
  });
  const space = token?.external_callers.spaces;
  if (!space) throw new ExternalApiError(401, 'EXTERNAL_TOKEN_INVALID', '外部访问凭证无效');
  if (!requireExecutionUser) return { configVersion: space.config_version, executionUserId: null };
  if (!space.execution_user_id) throw new ExternalApiError(409, 'EXECUTION_USER_DISABLED', '空间 execution user 当前不可用');
  const user = await tx.users.findFirst({
    where: { id: space.execution_user_id, tenant_id: access.caller.tenantId, status: 'active' },
    select: { id: true },
  });
  if (!user) throw new ExternalApiError(409, 'EXECUTION_USER_DISABLED', '空间 execution user 当前不可用');
  return { configVersion: space.config_version, executionUserId: user.id };
}

async function bindableArtifacts(
  tx: Transaction,
  access: ExternalCallerAccess,
  artifactIds: readonly string[],
): Promise<ExternalArtifactTokenSource[]> {
  if (!artifactIds.length) return [];
  const rows = await tx.artifacts.findMany({
    where: {
      id: { in: [...artifactIds] },
      caller_id: access.caller.id,
      space_id: access.caller.spaceId,
    },
    select: {
      id: true,
      original_name: true,
      mime_type: true,
      size_bytes: true,
      status: true,
      thread_id: true,
      run_id: true,
    },
  });
  if (rows.length !== artifactIds.length) {
    throw new ExternalApiError(404, 'ARTIFACT_NOT_FOUND', 'artifact 不存在或不属于当前调用方');
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return artifactIds.map((id) => {
    const row = byId.get(id)!;
    if (row.status !== 'staged' || row.thread_id || row.run_id) {
      throw new ExternalApiError(409, 'ARTIFACT_ALREADY_BOUND', `artifact 已被其他输入绑定：${id}`);
    }
    const size = Number(row.size_bytes);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXTERNAL_ARTIFACT_BYTES) {
      throw new ExternalApiError(409, 'ARTIFACT_SIZE_INVALID', `artifact 大小无效：${id}`);
    }
    return { id: row.id, name: row.original_name, mimeType: row.mime_type, size };
  });
}

async function claimArtifacts(
  tx: Transaction,
  access: ExternalCallerAccess,
  artifacts: readonly ExternalArtifactTokenSource[],
  threadId: string,
  runId: string,
): Promise<void> {
  if (!artifacts.length) return;
  const claimed = await tx.artifacts.updateMany({
    where: {
      id: { in: artifacts.map((artifact) => artifact.id) },
      caller_id: access.caller.id,
      space_id: access.caller.spaceId,
      status: 'staged',
      thread_id: null,
      run_id: null,
    },
    data: { thread_id: threadId, run_id: runId },
  });
  if (claimed.count !== artifacts.length) {
    throw new ExternalApiError(409, 'ARTIFACT_ALREADY_BOUND', 'artifact 已被其他并发请求绑定');
  }
}

async function existingRequest<T>(
  tx: Transaction,
  callerId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<T | null> {
  const row = await tx.external_requests.findFirst({
    where: { caller_id: callerId, operation, idempotency_key: idempotencyKey },
  });
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new ExternalApiError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同请求');
  }
  if (row.status !== 'succeeded' || !row.response) {
    throw new ExternalApiError(409, 'REQUEST_IN_PROGRESS', '该幂等请求尚未完成');
  }
  return jsonResponse<T>(row.response);
}

async function sourceReplay<T>(
  tx: Transaction,
  callerId: string,
  externalThreadRef: string | undefined,
  externalEventId: string | undefined,
  requestHash: string,
): Promise<T | null> {
  if (!externalThreadRef && !externalEventId) return null;
  const row = await tx.external_requests.findFirst({
    where: {
      caller_id: callerId,
      OR: [
        ...(externalThreadRef ? [{ external_thread_ref: externalThreadRef }] : []),
        ...(externalEventId ? [{ external_event_id: externalEventId }] : []),
      ],
    },
  });
  if (!row) return null;
  if (row.request_hash === requestHash && row.status === 'succeeded' && row.response) {
    return jsonResponse<T>(row.response);
  }
  throw new ExternalApiError(409, 'SOURCE_REFERENCE_CONFLICT', '外部来源引用已经被其他请求使用');
}

export class PrismaExternalRepository implements ExternalRepository {
  async authenticateToken(tokenHash: string): Promise<ExternalCallerAccess | null> {
    const now = new Date();
    const touched = await prisma.external_tokens.updateMany({
      where: {
        token_hash: tokenHash,
        revoked_at: null,
        OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        external_callers: {
          status: 'active',
          tenants: { status: 'active' },
          spaces: { mode: 'external', deleted_at: null },
        },
      },
      data: { last_used_at: now },
    });
    if (!touched.count) return null;
    const row = await prisma.external_tokens.findUnique({
      where: { token_hash: tokenHash },
      include: {
        external_callers: {
          include: {
            spaces: { include: { space_visible_users: { select: { user_id: true } } } },
            tenants: { select: { status: true } },
          },
        },
      },
    });
    if (!row) return null;
    return {
      caller: callerSummary(row.external_callers),
      token: tokenSummary({ ...row, last_used_at: now }),
      space: {
        ...toSpaceRow(row.external_callers.spaces),
        visible_user_ids: row.external_callers.spaces.space_visible_users.map((entry) => entry.user_id).sort(),
      },
    };
  }

  async createCaller(input: {
    tenantId: string;
    spaceId: string;
    name: string;
    metadata: Record<string, unknown>;
    tokenHash: string;
    tokenLabel: string | null;
    tokenExpiresAt: string | null;
  }): Promise<ExternalCallerWithTokens> {
    const result = await prisma.$transaction(async (tx) => {
      const space = await tx.spaces.findFirst({
        where: { id: input.spaceId, tenant_id: input.tenantId, mode: 'external', deleted_at: null },
        select: { id: true },
      });
      if (!space) throw new ExternalApiError(404, 'SPACE_NOT_FOUND', '外部空间不存在');
      const caller = await tx.external_callers.create({
        data: {
          id: newExternalCallerId(),
          tenant_id: input.tenantId,
          space_id: input.spaceId,
          name: input.name,
          metadata: requiredJson(input.metadata),
        },
      });
      const token = await tx.external_tokens.create({
        data: {
          id: newExternalTokenId(),
          caller_id: caller.id,
          token_hash: input.tokenHash,
          label: input.tokenLabel,
          expires_at: dateOrNull(input.tokenExpiresAt),
        },
      });
      return { caller, token };
    });
    return { caller: callerSummary(result.caller), tokens: [tokenSummary(result.token)] };
  }

  async listCallers(tenantId: string, spaceId: string): Promise<ExternalCallerWithTokens[]> {
    const rows = await prisma.external_callers.findMany({
      where: { tenant_id: tenantId, space_id: spaceId },
      include: { external_tokens: { orderBy: { created_at: 'desc' } } },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((row) => ({
      caller: callerSummary(row),
      tokens: row.external_tokens.map(tokenSummary),
    }));
  }

  async updateCaller(input: {
    tenantId: string;
    spaceId: string;
    callerId: string;
    name?: string;
    status?: 'active' | 'disabled';
    metadata?: Record<string, unknown>;
  }): Promise<ExternalCallerSummary | null> {
    const updated = await prisma.external_callers.updateMany({
      where: { id: input.callerId, tenant_id: input.tenantId, space_id: input.spaceId },
      data: {
        name: input.name,
        status: input.status,
        metadata: input.metadata === undefined ? undefined : requiredJson(input.metadata),
        updated_at: new Date(),
      },
    });
    if (!updated.count) return null;
    const row = await prisma.external_callers.findUnique({ where: { id: input.callerId } });
    return row ? callerSummary(row) : null;
  }

  async issueToken(input: {
    tenantId: string;
    spaceId: string;
    callerId: string;
    tokenHash: string;
    label: string | null;
    expiresAt: string | null;
  }): Promise<ExternalTokenSummary | null> {
    const caller = await prisma.external_callers.findFirst({
      where: {
        id: input.callerId,
        tenant_id: input.tenantId,
        space_id: input.spaceId,
        status: 'active',
        spaces: { mode: 'external', deleted_at: null },
      },
      select: { id: true },
    });
    if (!caller) return null;
    return tokenSummary(await prisma.external_tokens.create({
      data: {
        id: newExternalTokenId(),
        caller_id: caller.id,
        token_hash: input.tokenHash,
        label: input.label,
        expires_at: dateOrNull(input.expiresAt),
      },
    }));
  }

  async revokeToken(tenantId: string, spaceId: string, callerId: string, tokenId: string): Promise<ExternalTokenSummary | null> {
    const token = await prisma.external_tokens.findFirst({
      where: { id: tokenId, caller_id: callerId, external_callers: { tenant_id: tenantId, space_id: spaceId } },
    });
    if (!token) return null;
    return tokenSummary(await prisma.external_tokens.update({
      where: { id: token.id },
      data: { revoked_at: token.revoked_at ?? new Date() },
    }));
  }

  async createRun(access: ExternalCallerAccess, input: ExternalRunWriteInput): Promise<ExternalWriteResult<ExternalRunReceipt>> {
    try {
      return await prisma.$transaction(async (tx) => {
        const replay = await existingRequest<ExternalRunReceipt>(
          tx, access.caller.id, 'run.create', input.idempotencyKey, input.requestHash,
        );
        if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
        const sourceDuplicate = await sourceReplay<ExternalRunReceipt>(
          tx,
          access.caller.id,
          input.source.externalThreadRef,
          input.source.externalEventId,
          input.requestHash,
        );
        if (sourceDuplicate) return { response: sourceDuplicate, replayed: true, executionUserId: access.space.execution_user_id! };
        const live = await requireLiveAccess(tx, access, true);
        if (live.configVersion !== input.snapshot.configVersion) throw new SpaceConfigChangedError();

        const artifacts = await bindableArtifacts(tx, access, input.artifactIds ?? []);

        const threadId = newThreadId();
        const runId = newRunId();
        await tx.threads.create({
          data: {
            id: threadId,
            tenant_id: access.caller.tenantId,
            user_id: live.executionUserId!,
            space_id: access.caller.spaceId,
            source_type: 'external',
            source_caller_id: access.caller.id,
            source_ref: requiredJson(input.source),
            title: input.title ?? null,
          },
        });
        await tx.runs.create({
          data: {
            id: runId,
            thread_id: threadId,
            status: 'pending',
            input: input.input,
            model_ref: input.snapshot.modelRef,
            runtime_capabilities_snapshot: requiredJson(input.snapshot.runtimeCapabilities),
            space_config_snapshot: requiredJson(input.snapshot.spaceConfig),
            space_config_version: input.snapshot.configVersion,
            external_input_open: input.snapshot.spaceConfig.external.allowNextStep,
          },
        });
        await claimArtifacts(tx, access, artifacts, threadId, runId);
        await tx.threads.update({
          where: { id: threadId },
          data: { active_run_id: runId, executing_run_id: runId, updated_at: new Date() },
        });
        const response: ExternalRunReceipt = { operation: 'run.create', threadId, runId, status: 'pending' };
        await tx.external_requests.create({
          data: {
            id: newExternalRequestId(),
            caller_id: access.caller.id,
            operation: 'run.create',
            idempotency_key: input.idempotencyKey,
            request_hash: input.requestHash,
            status: 'succeeded',
            response: requiredJson(response),
            external_thread_ref: input.source.externalThreadRef,
            external_event_id: input.source.externalEventId,
            source_ref: requestSource(input),
            thread_id: threadId,
            run_id: runId,
          },
        });
        return { response, replayed: false, executionUserId: live.executionUserId! };
      });
    } catch (error) {
      const replay = await this.findIdempotentResponse<ExternalRunReceipt>(
        access.caller.id, 'run.create', input.idempotencyKey, input.requestHash,
      );
      if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
      if (
        isUniqueConflict(error)
        || (error instanceof ExternalApiError && error.code === 'ARTIFACT_ALREADY_BOUND')
      ) {
        const replay = await this.findRequestOrSourceReplay<ExternalRunReceipt>(
          access, 'run.create', input.idempotencyKey, input.requestHash, input.source.externalThreadRef, input.source.externalEventId,
        );
        if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
      }
      throw error;
    }
  }

  async appendRun(access: ExternalCallerAccess, input: ExternalAppendRunInput): Promise<ExternalWriteResult<ExternalRunReceipt>> {
    try {
      return await prisma.$transaction(async (tx) => {
        const replay = await existingRequest<ExternalRunReceipt>(
          tx, access.caller.id, 'run.append', input.idempotencyKey, input.requestHash,
        );
        if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
        const sourceDuplicate = await sourceReplay<ExternalRunReceipt>(
          tx, access.caller.id, undefined, input.source.externalEventId, input.requestHash,
        );
        if (sourceDuplicate) return { response: sourceDuplicate, replayed: true, executionUserId: access.space.execution_user_id! };
        const live = await requireLiveAccess(tx, access, false);
        if (live.configVersion !== input.snapshot.configVersion) throw new SpaceConfigChangedError();
        const thread = await tx.threads.findFirst({
          where: {
            id: input.threadId,
            tenant_id: access.caller.tenantId,
            space_id: access.caller.spaceId,
            source_type: 'external',
            source_caller_id: access.caller.id,
          },
          select: { active_run_id: true, executing_run_id: true, user_id: true },
        });
        if (!thread?.user_id) throw new ExternalApiError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
        const executionUser = await tx.users.findFirst({
          where: { id: thread.user_id, tenant_id: access.caller.tenantId, status: 'active' },
          select: { id: true },
        });
        if (!executionUser) {
          throw new ExternalApiError(409, 'EXECUTION_USER_DISABLED', 'thread 的 execution user 当前不可用');
        }
        if (thread.executing_run_id) throw await occupiedRunError(tx, input.threadId);

        const artifacts = await bindableArtifacts(tx, access, input.artifactIds ?? []);

        const runId = newRunId();
        await tx.runs.create({
          data: {
            id: runId,
            thread_id: input.threadId,
            parent_run_id: thread.active_run_id,
            status: 'pending',
            input: input.input,
            model_ref: input.snapshot.modelRef,
            runtime_capabilities_snapshot: requiredJson(input.snapshot.runtimeCapabilities),
            space_config_snapshot: requiredJson(input.snapshot.spaceConfig),
            space_config_version: input.snapshot.configVersion,
            external_input_open: input.snapshot.spaceConfig.external.allowNextStep,
          },
        });
        const claimed = await tx.threads.updateMany({
          where: { id: input.threadId, executing_run_id: null },
          data: { active_run_id: runId, executing_run_id: runId, updated_at: new Date() },
        });
        if (!claimed.count) throw await occupiedRunError(tx, input.threadId);
        await claimArtifacts(tx, access, artifacts, input.threadId, runId);
        const response: ExternalRunReceipt = {
          operation: 'run.append', threadId: input.threadId, runId, status: 'pending',
        };
        await tx.external_requests.create({
          data: {
            id: newExternalRequestId(),
            caller_id: access.caller.id,
            operation: 'run.append',
            idempotency_key: input.idempotencyKey,
            request_hash: input.requestHash,
            status: 'succeeded',
            response: requiredJson(response),
            external_event_id: input.source.externalEventId,
            source_ref: requestSource(input),
            thread_id: input.threadId,
            run_id: runId,
          },
        });
        return { response, replayed: false, executionUserId: executionUser.id };
      });
    } catch (error) {
      const replay = await this.findIdempotentResponse<ExternalRunReceipt>(
        access.caller.id, 'run.append', input.idempotencyKey, input.requestHash,
      );
      if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
      if (
        isUniqueConflict(error)
        || (error instanceof ExternalApiError && error.code === 'ARTIFACT_ALREADY_BOUND')
        || error instanceof RunActiveError
      ) {
        const source = await this.findRequestOrSourceReplay<ExternalRunReceipt>(
          access, 'run.append', input.idempotencyKey, input.requestHash, undefined, input.source.externalEventId,
        );
        if (source) return { response: source, replayed: true, executionUserId: access.space.execution_user_id! };
      }
      throw error;
    }
  }

  async appendNextStep(
    access: ExternalCallerAccess,
    input: Omit<ExternalAppendRunInput, 'snapshot'>,
  ): Promise<ExternalWriteResult<ExternalNextStepReceipt>> {
    try {
      return await prisma.$transaction(async (tx) => {
        const replay = await existingRequest<ExternalNextStepReceipt>(
          tx, access.caller.id, 'run.append', input.idempotencyKey, input.requestHash,
        );
        if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
        const sourceDuplicate = await sourceReplay<ExternalNextStepReceipt>(
          tx, access.caller.id, undefined, input.source.externalEventId, input.requestHash,
        );
        if (sourceDuplicate) return { response: sourceDuplicate, replayed: true, executionUserId: access.space.execution_user_id! };
        await requireLiveAccess(tx, access, false);
        const thread = await tx.threads.findFirst({
          where: {
            id: input.threadId,
            tenant_id: access.caller.tenantId,
            space_id: access.caller.spaceId,
            source_type: 'external',
            source_caller_id: access.caller.id,
          },
          select: { executing_run_id: true, user_id: true },
        });
        if (!thread?.user_id) {
          throw new ExternalApiError(404, 'THREAD_NOT_FOUND', 'thread 不存在');
        }
        if (!thread.executing_run_id) {
          throw new ExternalApiError(409, 'RUN_NOT_ACTIVE', 'thread 当前没有可接收 next_step 的活动 run');
        }
        const run = await tx.runs.findUnique({
          where: { id: thread.executing_run_id },
          select: { space_config_snapshot: true },
        });
        const snapshot = run?.space_config_snapshot as { external?: { allowNextStep?: unknown } } | null;
        if (snapshot?.external?.allowNextStep !== true) {
          throw new ExternalApiError(403, 'NEXT_STEP_DISABLED', '目标 run 的空间配置未允许 next_step');
        }
        const artifacts = await bindableArtifacts(tx, access, input.artifactIds ?? []);
        const accepted = await tx.runs.updateMany({
          where: {
            id: thread.executing_run_id,
            status: { in: ['pending', 'running'] },
            external_input_open: true,
          },
          data: { input_version: { increment: 1 }, updated_at: new Date() },
        });
        if (!accepted.count) {
          throw new ExternalApiError(409, 'RUN_INPUT_CLOSED', '目标 run 已停止接收 next_step 输入');
        }
        const updated = await tx.runs.findUnique({
          where: { id: thread.executing_run_id },
          select: { input_version: true },
        });
        if (!updated) throw new ExternalApiError(404, 'RUN_NOT_FOUND', 'run 不存在');
        const requestId = newExternalRequestId();
        await tx.external_requests.create({
          data: {
            id: requestId,
            caller_id: access.caller.id,
            operation: 'run.append',
            idempotency_key: input.idempotencyKey,
            request_hash: input.requestHash,
            status: 'processing',
            external_event_id: input.source.externalEventId,
            source_ref: requestSource(input),
            thread_id: input.threadId,
            run_id: thread.executing_run_id,
          },
        });
        const inputId = newRunInputId();
        await tx.run_inputs.create({
          data: {
            id: inputId,
            run_id: thread.executing_run_id,
            caller_id: access.caller.id,
            external_request_id: requestId,
            version: updated.input_version,
            content: input.input,
            artifacts: requiredJson(artifacts.map((artifact) => artifact.id)),
          },
        });
        await claimArtifacts(tx, access, artifacts, input.threadId, thread.executing_run_id);
        const response: ExternalNextStepReceipt = {
          operation: 'run.append',
          delivery: 'next_step',
          threadId: input.threadId,
          runId: thread.executing_run_id,
          inputId,
          version: updated.input_version,
          status: 'accepted',
        };
        await tx.external_requests.update({
          where: { id: requestId },
          data: { status: 'succeeded', response: requiredJson(response), updated_at: new Date() },
        });
        return { response, replayed: false, executionUserId: thread.user_id };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const replay = await this.findRequestOrSourceReplay<ExternalNextStepReceipt>(
          access, 'run.append', input.idempotencyKey, input.requestHash, undefined, input.source.externalEventId,
        );
        if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
      }
      throw error;
    }
  }

  async createArtifact(
    access: ExternalCallerAccess,
    input: ExternalArtifactCreateInput,
  ): Promise<{ response: ExternalArtifactUploadReceipt; replayed: boolean }> {
    try {
      return await prisma.$transaction(async (tx) => {
        const replay = await existingRequest<ExternalArtifactUploadReceipt>(
          tx, access.caller.id, 'artifact.upload', input.idempotencyKey, input.requestHash,
        );
        if (replay) return { response: replay, replayed: true };
        const sourceDuplicate = await sourceReplay<ExternalArtifactUploadReceipt>(
          tx, access.caller.id, undefined, input.source.externalEventId, input.requestHash,
        );
        if (sourceDuplicate) return { response: sourceDuplicate, replayed: true };
        await requireLiveAccess(tx, access, false);
        const requestId = newExternalRequestId();
        await tx.external_requests.create({
          data: {
            id: requestId,
            caller_id: access.caller.id,
            operation: 'artifact.upload',
            idempotency_key: input.idempotencyKey,
            request_hash: input.requestHash,
            status: 'processing',
            external_event_id: input.source.externalEventId,
            source_ref: requestSource(input),
          },
        });
        const artifact = await tx.artifacts.create({
          data: {
            id: input.artifactId,
            caller_id: access.caller.id,
            space_id: access.caller.spaceId,
            storage_key: input.storageKey,
            original_name: input.name,
            mime_type: input.mimeType,
            size_bytes: BigInt(input.size),
            metadata: requiredJson(input.metadata),
          },
        });
        const response: ExternalArtifactUploadReceipt = {
          operation: 'artifact.upload',
          artifact: artifactSummary(artifact),
        };
        await tx.external_requests.update({
          where: { id: requestId },
          data: { status: 'succeeded', response: requiredJson(response), updated_at: new Date() },
        });
        return { response, replayed: false };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const replay = await this.findRequestOrSourceReplay<ExternalArtifactUploadReceipt>(
          access, 'artifact.upload', input.idempotencyKey, input.requestHash, undefined, input.source.externalEventId,
        );
        if (replay) return { response: replay, replayed: true };
      }
      throw error;
    }
  }

  async findArtifactUploadReplay(
    access: ExternalCallerAccess,
    input: Pick<ExternalArtifactCreateInput, 'idempotencyKey' | 'requestHash' | 'source'>,
  ): Promise<ExternalArtifactUploadReceipt | null> {
    return this.findRequestOrSourceReplay<ExternalArtifactUploadReceipt>(
      access,
      'artifact.upload',
      input.idempotencyKey,
      input.requestHash,
      undefined,
      input.source.externalEventId,
    );
  }

  async getArtifact(
    access: ExternalCallerAccess,
    artifactId: string,
  ): Promise<{ artifact: ExternalArtifactSummary; storageKey: string } | null> {
    const row = await prisma.artifacts.findFirst({
      where: {
        id: artifactId,
        caller_id: access.caller.id,
        space_id: access.caller.spaceId,
        status: { not: 'deleted' },
      },
    });
    return row ? { artifact: artifactSummary(row), storageKey: row.storage_key } : null;
  }

  async getRun(access: ExternalCallerAccess, runId: string): Promise<{ response: ExternalRunView; executionUserId: string } | null> {
    const row = await prisma.runs.findFirst({
      where: {
        id: runId,
        threads_runs_thread_idTothreads: {
          tenant_id: access.caller.tenantId,
          space_id: access.caller.spaceId,
          source_type: 'external',
          source_caller_id: access.caller.id,
        },
      },
      include: { threads_runs_thread_idTothreads: { select: { user_id: true } } },
    });
    const executionUserId = row?.threads_runs_thread_idTothreads.user_id;
    if (!row || !executionUserId) return null;
    const run = toRunRow(row);
    return {
      executionUserId,
      response: {
        operation: 'run.get',
        threadId: run.thread_id,
        runId: run.id,
        status: run.status,
        input: run.input,
        output: run.output,
        error: run.error,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      },
    };
  }

  async cancelRun(access: ExternalCallerAccess, input: ExternalCancelInput): Promise<ExternalWriteResult<ExternalCancelReceipt> | null> {
    try {
      return await prisma.$transaction(async (tx) => {
        const replay = await existingRequest<ExternalCancelReceipt>(
          tx, access.caller.id, 'run.cancel', input.idempotencyKey, input.requestHash,
        );
        if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
        const sourceDuplicate = await sourceReplay<ExternalCancelReceipt>(
          tx, access.caller.id, undefined, input.source.externalEventId, input.requestHash,
        );
        if (sourceDuplicate) return { response: sourceDuplicate, replayed: true, executionUserId: access.space.execution_user_id! };
        await requireLiveAccess(tx, access, false);
        const row = await tx.runs.findFirst({
          where: {
            id: input.runId,
            threads_runs_thread_idTothreads: {
              tenant_id: access.caller.tenantId,
              space_id: access.caller.spaceId,
              source_type: 'external',
              source_caller_id: access.caller.id,
            },
          },
          include: { threads_runs_thread_idTothreads: { select: { user_id: true } } },
        });
        const executionUserId = row?.threads_runs_thread_idTothreads.user_id;
        if (!row || !executionUserId) return null;
        const current = row.status as RunStatus;
        const status: RunStatus = current === 'pending' || current === 'running' ? 'canceling' : current;
        if (status === 'canceling') {
          const now = new Date();
          await tx.runs.update({
            where: { id: row.id },
            data: { status, external_input_open: false, updated_at: now },
          });
          await tx.run_inputs.updateMany({
            where: { run_id: row.id, status: 'pending' },
            data: { status: 'canceled', canceled_at: now },
          });
        }
        const response: ExternalCancelReceipt = {
          operation: 'run.cancel', threadId: row.thread_id, runId: row.id, status,
        };
        await tx.external_requests.create({
          data: {
            id: newExternalRequestId(),
            caller_id: access.caller.id,
            operation: 'run.cancel',
            idempotency_key: input.idempotencyKey,
            request_hash: input.requestHash,
            status: 'succeeded',
            response: requiredJson(response),
            external_event_id: input.source.externalEventId,
            source_ref: requestSource(input),
            thread_id: row.thread_id,
            run_id: row.id,
          },
        });
        return { response, replayed: false, executionUserId };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const replay = await this.findRequestOrSourceReplay<ExternalCancelReceipt>(
          access, 'run.cancel', input.idempotencyKey, input.requestHash, undefined, input.source.externalEventId,
        );
        if (replay) return { response: replay, replayed: true, executionUserId: access.space.execution_user_id! };
      }
      throw error;
    }
  }

  private async findIdempotentResponse<T>(callerId: string, operation: string, idempotencyKey: string, requestHash: string): Promise<T | null> {
    const row = await prisma.external_requests.findFirst({
      where: { caller_id: callerId, operation, idempotency_key: idempotencyKey },
    });
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      throw new ExternalApiError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同请求');
    }
    return row.status === 'succeeded' && row.response ? jsonResponse<T>(row.response) : null;
  }

  private async findRequestOrSourceReplay<T>(
    access: ExternalCallerAccess,
    operation: string,
    idempotencyKey: string,
    requestHash: string,
    externalThreadRef?: string,
    externalEventId?: string,
  ): Promise<T | null> {
    return prisma.$transaction(async (tx) => {
      const request = await existingRequest<T>(tx, access.caller.id, operation, idempotencyKey, requestHash);
      if (request) return request;
      return sourceReplay<T>(tx, access.caller.id, externalThreadRef, externalEventId, requestHash);
    });
  }
}

export const externalRepository = new PrismaExternalRepository();

/** 启动期文件对账只读取不透明 storage key，数据库访问仍收敛在 repository 层。 */
export async function listArtifactStorageKeys(): Promise<Set<string>> {
  const rows = await prisma.artifacts.findMany({ select: { storage_key: true } });
  return new Set(rows.map((row) => row.storage_key));
}

export interface RunArtifactForMaterialization {
  id: string;
  storageKey: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'staged' | 'materialized';
  initialInput: boolean;
}

/** executor 内部入口：返回当前执行 scope/run 的附件；staged 项需要落盘，全部项用于派生文件 token。 */
export async function listRunArtifactsForMaterialization(
  scope: { tenantId: string; userId: string },
  runId: string,
): Promise<RunArtifactForMaterialization[]> {
  return prisma.$transaction(async (tx) => {
    // 先读 artifact、再读 run_inputs：并发接纳的 next_step 要么两边都可见，要么本轮
    // 两边都不处理，不能把 next_step 附件误挂到初始 user message。
    const rows = await tx.artifacts.findMany({
      where: {
        run_id: runId,
        status: { in: ['staged', 'materialized'] },
        runs: {
          threads_runs_thread_idTothreads: {
            tenant_id: scope.tenantId,
            user_id: scope.userId,
          },
        },
      },
      select: { id: true, storage_key: true, original_name: true, mime_type: true, size_bytes: true, status: true },
      orderBy: { created_at: 'asc' },
    });
    const inputs = await tx.run_inputs.findMany({
      where: { run_id: runId },
      select: { artifacts: true },
    });
    const nextStepArtifactIds = new Set(inputs.flatMap((input) => (
      Array.isArray(input.artifacts)
        ? input.artifacts.filter((id): id is string => typeof id === 'string')
        : []
    )));
    return rows.map((row) => {
      const size = Number(row.size_bytes);
      if (!Number.isSafeInteger(size)) throw new Error(`artifact 大小超出 JavaScript 安全整数范围：${row.size_bytes}`);
      return {
        id: row.id,
        storageKey: row.storage_key,
        name: row.original_name,
        mimeType: row.mime_type,
        size,
        status: row.status as RunArtifactForMaterialization['status'],
        initialInput: !nextStepArtifactIds.has(row.id),
      };
    });
  });
}

export async function markRunArtifactMaterialized(
  scope: { tenantId: string; userId: string },
  runId: string,
  artifactId: string,
): Promise<void> {
  const updated = await prisma.artifacts.updateMany({
    where: {
      id: artifactId,
      run_id: runId,
      status: 'staged',
      runs: {
        threads_runs_thread_idTothreads: {
          tenant_id: scope.tenantId,
          user_id: scope.userId,
        },
      },
    },
    data: { status: 'materialized', materialized_at: new Date() },
  });
  if (!updated.count) {
    const alreadyDone = await prisma.artifacts.count({
      where: {
        id: artifactId,
        run_id: runId,
        status: 'materialized',
        runs: {
          threads_runs_thread_idTothreads: {
            tenant_id: scope.tenantId,
            user_id: scope.userId,
          },
        },
      },
    });
    if (!alreadyDone) throw new Error(`artifact materialize 状态已变化：${artifactId}`);
  }
}
