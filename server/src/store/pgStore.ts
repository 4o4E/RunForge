import { pool, query } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder, maskToolCallArguments } from '../agent/compaction.js';
import type { GoalState } from '../agent/goal.js';
import { sanitizeThreadMessagesForModel } from './messageView.js';
import { DefaultSpaceImmutableError, isTerminalRunStatus, RunActiveError, SpaceConfigChangedError } from './types.js';
import type {
  AuthTokenRow,
  AppliedRunInput,
  CreateRunOptions,
  CreateSpaceRecordInput,
  CreateTenantWithOwnerInput,
  PushSubscriptionRow,
  RawThreadMessage,
  RunRow,
  Scope,
  ShellActor,
  ShellCommandLogRow,
  ShellCommandRow,
  ShellLogStream,
  ShellSessionRow,
  Store,
  StoredEvent,
  SpaceRow,
  SpaceWithVisibilityRow,
  SubagentRunRow,
  StepRow,
  SystemAdminRow,
  SystemAdminTokenRow,
  TenantRow,
  ThreadNoticeRow,
  ThreadMessage,
  ThreadMessageMetadata,
  ThreadSearchResultRow,
  ThreadRow,
  UserRow,
  UpdateSpaceRecordInput,
} from './types.js';
import type { TenantUserRole, WebPushSubscriptionInput } from '@runforge/contracts';
import {
  newAuthTokenId,
  newRunId,
  newShellCommandId,
  newShellSessionId,
  newSpaceId,
  newStepId,
  newSubagentRunId,
  newSystemAdminId,
  newSystemAdminTokenId,
  newThreadId,
  newUserId,
} from '../id.js';
import {
  nullableJson,
  requiredJson,
  serialId,
  toAuthTokenRow,
  toRunRow,
  toSpaceRow,
  toStepRow,
  toSystemAdminRow,
  toSystemAdminTokenRow,
  toTenantRow,
  toThreadNoticeRow,
  toThreadRow,
  toUserRow,
} from './prismaRows.js';
import { attachExternalArtifactTokens } from '../external/artifactProtocol.js';

function isEphemeralSystemMessage(role: LlmMessage['role'], content: string | null): boolean {
  return role === 'system' && typeof content === 'string' && content.startsWith('已激活 Skill / Activated Skill:');
}

function allowsExternalNextStep(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const value = snapshot as { mode?: unknown; external?: { allowNextStep?: unknown } };
  return value.mode === 'external' && value.external?.allowNextStep === true;
}

function runInputArtifactIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('run input 的 artifacts 不是数组');
  const ids = value.filter((item): item is string => typeof item === 'string' && /^ar_[0-9A-Za-z]+$/.test(item));
  if (ids.length !== value.length || new Set(ids).size !== ids.length) {
    throw new Error('run input 的 artifact ID 无效或重复');
  }
  return ids;
}

async function contentWithRunInputArtifacts(
  tx: Prisma.TransactionClient,
  runId: string,
  content: string,
  value: unknown,
): Promise<string> {
  const ids = runInputArtifactIds(value);
  if (!ids.length) return content;
  const rows = await tx.artifacts.findMany({
    where: { id: { in: ids }, run_id: runId, status: { in: ['staged', 'materialized'] } },
    select: { id: true, original_name: true, mime_type: true, size_bytes: true },
  });
  if (rows.length !== ids.length) throw new Error('run input 引用的 artifact 不存在或绑定关系已变化');
  const byId = new Map(rows.map((row) => [row.id, row]));
  return attachExternalArtifactTokens(content, ids.map((id) => {
    const row = byId.get(id)!;
    const size = Number(row.size_bytes);
    if (!Number.isSafeInteger(size)) throw new Error(`artifact 大小超出 JavaScript 安全整数范围：${row.size_bytes}`);
    return { id, name: row.original_name, mimeType: row.mime_type, size };
  }));
}

async function applyPendingRunInputsInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  threadId: string,
): Promise<AppliedRunInput[]> {
  const pending = await tx.run_inputs.findMany({
    where: { run_id: runId, status: 'pending' },
    select: { id: true, version: true, content: true, artifacts: true },
    orderBy: { version: 'asc' },
  });
  const applied: AppliedRunInput[] = [];
  for (const input of pending) {
    // status CAS 使意外并发的两个 executor 也只有一个能创建对应 user message。
    const claimed = await tx.run_inputs.updateMany({
      where: { id: input.id, status: 'pending' },
      data: { status: 'applied', applied_at: new Date() },
    });
    if (!claimed.count) continue;
    const content = await contentWithRunInputArtifacts(tx, runId, input.content, input.artifacts);
    const message = await tx.messages.create({
      data: {
        thread_id: threadId,
        run_id: runId,
        role: 'user',
        content,
      },
      select: { id: true },
    });
    applied.push({
      inputId: input.id,
      version: input.version,
      content,
      messageId: serialId(message.id),
    });
  }
  return applied;
}

async function occupiedRunError(tx: Prisma.TransactionClient, threadId: string): Promise<Error> {
  const occupied = await tx.threads.findUnique({
    where: { id: threadId },
    select: {
      executing_run_id: true,
      runs_threads_executing_run_idToruns: { select: { status: true } },
    },
  });
  if (occupied?.executing_run_id) {
    return new RunActiveError(
      occupied.executing_run_id,
      (occupied.runs_threads_executing_run_idToruns?.status as RunStatus | undefined) ?? 'running',
    );
  }
  return new Error('未能占用 thread 执行槽，请重试');
}

function toSpaceWithVisibility(
  row: Parameters<typeof toSpaceRow>[0] & { space_visible_users: Array<{ user_id: string }> },
): SpaceWithVisibilityRow {
  return {
    ...toSpaceRow(row),
    visible_user_ids: row.space_visible_users.map((entry) => entry.user_id).sort(),
  };
}

export class PgStore implements Store {
  // 多租户改造 Phase 2(docs/multi-tenancy-design.md §5)。这两个私有帮助方法只给
  // 结构复杂、不方便直接把 scope 塞进查询本身的方法用(递归 CTE、多步聚合)——
  // 先校验归属,查不到就让调用方按"空结果"处理,再跑原来没改动过的查询逻辑,
  // 降低在复杂 SQL 里手改引入 bug 的风险。其余简单查询直接把 scope 折进 WHERE/JOIN。
  private async threadBelongsToScope(scope: Scope, threadId: string): Promise<boolean> {
    return await prisma.threads.count({
      where: { id: threadId, tenant_id: scope.tenantId, user_id: scope.userId },
    }) > 0;
  }

  private async runBelongsToScope(scope: Scope, runId: string, threadId?: string): Promise<boolean> {
    return await prisma.runs.count({
      where: {
        id: runId,
        thread_id: threadId,
        threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
      },
    }) > 0;
  }

  /** thread 只展示 active run 到根节点这一条分支；旧线性数据没有 active run 时展示全部 run。 */
  private async visibleRunIds(scope: Scope, threadId: string, selectedRunId?: string | null): Promise<string[] | null> {
    const thread = await prisma.threads.findFirst({
      where: { id: threadId, tenant_id: scope.tenantId, user_id: scope.userId },
      select: { active_run_id: true },
    });
    if (!thread) return null;
    const runs = await prisma.runs.findMany({
      where: { thread_id: threadId },
      select: { id: true, parent_run_id: true },
    });
    const target = selectedRunId ?? thread.active_run_id;
    if (!target) return runs.map((run) => run.id);

    const byId = new Map(runs.map((run) => [run.id, run]));
    if (!byId.has(target)) return [];
    const result: string[] = [];
    const visited = new Set<string>();
    let current: string | null = target;
    while (current && !visited.has(current)) {
      visited.add(current);
      result.push(current);
      current = byId.get(current)?.parent_run_id ?? null;
    }
    return result;
  }

  async createThread(scope: Scope, title?: string, options: { spaceId?: string } = {}): Promise<ThreadRow> {
    const row = await prisma.$transaction(async (tx) => {
      const user = await tx.users.findFirst({
        where: { id: scope.userId, tenant_id: scope.tenantId, status: 'active' },
        select: { id: true, role: true },
      });
      if (!user) throw new Error('当前用户不存在或已禁用');
      const targetSpaceId = options.spaceId ?? (await tx.tenants.findUnique({
        where: { id: scope.tenantId },
        select: { default_space_id: true },
      }))?.default_space_id;
      const space = targetSpaceId ? await tx.spaces.findFirst({
        where: {
          id: targetSpaceId,
          tenant_id: scope.tenantId,
          mode: 'web',
          deleted_at: null,
          ...((user.role === 'owner' || user.role === 'admin')
            ? {}
            : { space_visible_users: { some: { user_id: user.id } } }),
        },
      }) : null;
      if (!space) {
        throw new Error('space 不存在、已删除或不允许创建 Web 对话');
      }
      return tx.threads.create({
        data: {
          id: newThreadId(),
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          space_id: space.id,
          source_type: 'web',
          title: title ?? null,
        },
      });
    });
    return toThreadRow(row);
  }

  async getThread(scope: Scope, id: string): Promise<ThreadRow | null> {
    const row = await prisma.threads.findFirst({
      where: { id, tenant_id: scope.tenantId, user_id: scope.userId },
      include: {
        runs_runs_thread_idTothreads: {
          select: { input: true },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          take: 1,
        },
      },
    });
    return row ? toThreadRow(row, row.runs_runs_thread_idTothreads[0]?.input ?? null) : null;
  }

  async getThreadInSpaces(tenantId: string, id: string, spaceIds: string[]): Promise<ThreadRow | null> {
    if (!spaceIds.length) return null;
    const row = await prisma.threads.findFirst({
      where: { id, tenant_id: tenantId, space_id: { in: spaceIds } },
      include: {
        runs_runs_thread_idTothreads: {
          select: { input: true },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          take: 1,
        },
      },
    });
    return row ? toThreadRow(row, row.runs_runs_thread_idTothreads[0]?.input ?? null) : null;
  }

  async listThreads(scope: Scope, limit = 50, options: { archived?: boolean; spaceIds?: string[] } = {}): Promise<ThreadRow[]> {
    const rows = await prisma.threads.findMany({
      where: {
        tenant_id: scope.tenantId,
        user_id: scope.userId,
        space_id: options.spaceIds ? { in: options.spaceIds } : undefined,
        archived_at: options.archived === true ? { not: null } : null,
      },
      include: {
        runs_runs_thread_idTothreads: {
          select: { input: true },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          take: 1,
        },
      },
      orderBy: [{ pinned_at: { sort: 'desc', nulls: 'last' } }, { updated_at: 'desc' }, { created_at: 'desc' }],
      take: limit,
    });
    return rows.map((row) => toThreadRow(row, row.runs_runs_thread_idTothreads[0]?.input ?? null));
  }

  async listThreadsForViewer(
    scope: Scope,
    limit = 50,
    options: { archived?: boolean; webSpaceIds?: string[]; externalSpaceIds?: string[] } = {},
  ): Promise<ThreadRow[]> {
    const webSpaceIds = options.webSpaceIds ?? [];
    const externalSpaceIds = options.externalSpaceIds ?? [];
    if (!webSpaceIds.length && !externalSpaceIds.length) return [];
    const rows = await prisma.threads.findMany({
      where: {
        tenant_id: scope.tenantId,
        archived_at: options.archived === true ? { not: null } : null,
        OR: [
          ...(webSpaceIds.length ? [{ source_type: 'web' as const, user_id: scope.userId, space_id: { in: webSpaceIds } }] : []),
          ...(externalSpaceIds.length ? [{ source_type: 'external' as const, space_id: { in: externalSpaceIds } }] : []),
        ],
      },
      include: {
        runs_runs_thread_idTothreads: {
          select: { input: true },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          take: 1,
        },
      },
      orderBy: [{ pinned_at: { sort: 'desc', nulls: 'last' } }, { updated_at: 'desc' }, { created_at: 'desc' }],
      take: limit,
    });
    return rows.map((row) => toThreadRow(row, row.runs_runs_thread_idTothreads[0]?.input ?? null));
  }

  async updateThread(
    scope: Scope,
    id: string,
    fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null },
  ): Promise<ThreadRow | null> {
    const existing = await prisma.threads.findFirst({
      where: { id, tenant_id: scope.tenantId, user_id: scope.userId },
    });
    if (!existing) return null;

    let activeRunId = fields.activeRunId ?? null;
    if (fields.activeRunId) {
      const runRows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH RECURSIVE subtree AS (
          SELECT id, parent_run_id, created_at FROM runs
          WHERE id = ${fields.activeRunId} AND thread_id = ${id}
          UNION ALL
          SELECT child.id, child.parent_run_id, child.created_at
          FROM runs child JOIN subtree parent ON child.parent_run_id = parent.id
          WHERE child.thread_id = ${id}
        ),
        leaf_runs AS (
          SELECT run.id, run.created_at FROM subtree run
          WHERE NOT EXISTS (SELECT 1 FROM subtree child WHERE child.parent_run_id = run.id)
        )
        SELECT id FROM leaf_runs ORDER BY created_at DESC, id DESC LIMIT 1
      `);
      if (!runRows.length) return null;
      activeRunId = runRows[0].id;
    }
    const [row] = await prisma.threads.updateManyAndReturn({
      where: { id, tenant_id: scope.tenantId, user_id: scope.userId },
      data: {
        title: Object.prototype.hasOwnProperty.call(fields, 'title') ? fields.title ?? null : undefined,
        pinned_at: fields.pinned === undefined ? undefined : fields.pinned ? existing.pinned_at ?? new Date() : null,
        archived_at: fields.archived === undefined ? undefined : fields.archived ? existing.archived_at ?? new Date() : null,
        active_run_id: Object.prototype.hasOwnProperty.call(fields, 'activeRunId') ? activeRunId : undefined,
        updated_at: new Date(),
      },
    });
    return row ? toThreadRow(row) : null;
  }

  async setThreadTitleIfEmpty(scope: Scope, id: string, title: string): Promise<ThreadRow | null> {
    const rows = await prisma.$queryRaw<Array<Parameters<typeof toThreadRow>[0]>>(Prisma.sql`
      UPDATE threads SET title = ${title}, updated_at = now()
      WHERE id = ${id} AND tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND (title IS NULL OR btrim(title) = '')
      RETURNING *
    `);
    return rows[0] ? toThreadRow(rows[0]) : null;
  }

  async deleteThread(scope: Scope, id: string): Promise<boolean> {
    const result = await prisma.threads.deleteMany({
      where: { id, tenant_id: scope.tenantId, user_id: scope.userId },
    });
    return result.count > 0;
  }

  async searchThreadMessages(
    scope: Scope,
    searchText: string,
    limit = 50,
    options: { spaceIds?: string[] } = {},
  ): Promise<ThreadSearchResultRow[]> {
    const q = searchText.trim();
    if (!q) return [];
    const rows = await prisma.messages.findMany({
      where: {
        content: { not: null, contains: q, mode: 'insensitive' },
        role: { in: ['user', 'assistant'] },
        threads: {
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          space_id: options.spaceIds ? { in: options.spaceIds } : undefined,
        },
      },
      select: {
        thread_id: true,
        run_id: true,
        id: true,
        role: true,
        content: true,
        created_at: true,
        threads: { select: { title: true } },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((row) => ({
      thread_id: row.thread_id,
      thread_title: row.threads.title,
      run_id: row.run_id,
      message_id: serialId(row.id),
      role: row.role as 'user' | 'assistant',
      content: row.content!,
      created_at: row.created_at.toISOString(),
    }));
  }

  async listThreadNotices(scope: Scope, threadId: string): Promise<ThreadNoticeRow[]> {
    return (await prisma.thread_notices.findMany({
      where: {
        thread_id: threadId,
        threads_thread_notices_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })).map(toThreadNoticeRow);
  }

  async addThreadNotice(scope: Scope, input: {
    threadId: string;
    kind?: string;
    message: string;
    title?: string | null;
    linkedThreadId?: string | null;
    linkedRunId?: string | null;
  }): Promise<ThreadNoticeRow> {
    if (!(await this.threadBelongsToScope(scope, input.threadId))) {
      throw new Error('threadId 不存在或不属于当前用户');
    }
    return toThreadNoticeRow(await prisma.thread_notices.create({
      data: {
        thread_id: input.threadId,
        kind: input.kind ?? 'info',
        message: input.message,
        title: input.title ?? null,
        linked_thread_id: input.linkedThreadId ?? null,
        linked_run_id: input.linkedRunId ?? null,
      },
    }));
  }

  async forkThreadAtRun(scope: Scope, sourceRunId: string): Promise<{ thread: ThreadRow; activeRun: RunRow } | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: sourceRows } = await client.query<RunRow>(
        `SELECT r.* FROM runs r JOIN threads t ON t.id = r.thread_id
         WHERE r.id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
        [sourceRunId, scope.tenantId, scope.userId],
      );
      const source = sourceRows[0];
      if (!source) {
        await client.query('ROLLBACK');
        return null;
      }
      const { rows: sourceThreadRows } = await client.query<ThreadRow>(
        `SELECT * FROM threads WHERE id = $1`,
        [source.thread_id],
      );
      const sourceThread = sourceThreadRows[0];
      if (!sourceThread) {
        await client.query('ROLLBACK');
        return null;
      }

      const { rows: pathRows } = await client.query<RunRow & { depth: number }>(
        `WITH RECURSIVE branch AS (
           SELECT r.*, 1 AS depth
           FROM runs r
           WHERE r.id = $1

           UNION ALL

           SELECT parent.*, child.depth + 1 AS depth
           FROM runs parent
           JOIN branch child ON child.parent_run_id = parent.id
           WHERE parent.thread_id = child.thread_id
         )
         SELECT * FROM branch ORDER BY depth DESC`,
        [sourceRunId],
      );

      const forkThreadId = newThreadId();
      const forkTitle = sourceThread.title ? `${sourceThread.title} 的 fork` : 'Fork 对话';
      // fork 出的新 thread 归属发起 fork 的用户(scope),不是复制源 thread 的归属——
      // 能走到这里说明 sourceRunId 已经属于 scope 了,两者本来就是同一个 tenant/user。
      const { rows: newThreadRows } = await client.query<ThreadRow>(
        `INSERT INTO threads (id, tenant_id, user_id, space_id, source_type, title)
         VALUES ($1, $2, $3, $4, 'web', $5) RETURNING *`,
        [forkThreadId, scope.tenantId, scope.userId, sourceThread.space_id, forkTitle],
      );
      const newThread = newThreadRows[0];
      const runIdMap = new Map<string, string>();
      const stepIdMap = new Map<string, string>();
      const messageIdMap = new Map<number, number>();
      let activeRun: RunRow | null = null;

      for (const oldRun of pathRows) {
        const newRunIdValue = newRunId();
        runIdMap.set(oldRun.id, newRunIdValue);
        const parentRunId = oldRun.parent_run_id ? runIdMap.get(oldRun.parent_run_id) ?? null : null;
        const isSourceRun = oldRun.id === sourceRunId;
        // fork 只复制历史检查点，不复制执行权。异常旧数据里若祖先仍是非终态，
        // 必须在副本中收口为 error，避免启动恢复把历史副本再次执行。
        const copiedStatus = isSourceRun ? 'done' : isTerminalRunStatus(oldRun.status) ? oldRun.status : 'error';
        const { rows: runRows } = await client.query<RunRow>(
          `INSERT INTO runs (
             id, thread_id, parent_run_id, status, input, model_ref, output, error, goal_state,
             runtime_capabilities_snapshot, space_config_snapshot, space_config_version, plugin_lock,
             external_input_open, input_version, created_at, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             $10::jsonb, $11::jsonb, $12, $13::jsonb, false, $14, $15, $16
           )
           RETURNING *`,
          [
            newRunIdValue,
            forkThreadId,
            parentRunId,
            copiedStatus,
            oldRun.input,
            oldRun.model_ref,
            isSourceRun ? null : oldRun.output,
            isSourceRun ? null : copiedStatus === 'error' ? oldRun.error ?? 'fork 时停止了历史非终态 run。' : oldRun.error,
            oldRun.goal_state ? JSON.stringify(oldRun.goal_state) : null,
            oldRun.runtime_capabilities_snapshot ? JSON.stringify(oldRun.runtime_capabilities_snapshot) : null,
            oldRun.space_config_snapshot ? JSON.stringify(oldRun.space_config_snapshot) : null,
            oldRun.space_config_version,
            oldRun.plugin_lock ? JSON.stringify(oldRun.plugin_lock) : null,
            oldRun.input_version,
            oldRun.created_at,
            oldRun.updated_at,
          ],
        );
        const newRun = runRows[0];
        activeRun = newRun;

        if (!isSourceRun) {
          const { rows: oldSteps } = await client.query<StepRow>(
            `SELECT * FROM steps WHERE run_id = $1 ORDER BY idx`,
            [oldRun.id],
          );
          for (const oldStep of oldSteps) {
            const newStepIdValue = newStepId();
            stepIdMap.set(oldStep.id, newStepIdValue);
            await client.query(
              `INSERT INTO steps (id, run_id, idx, created_at) VALUES ($1, $2, $3, $4)`,
              [newStepIdValue, newRunIdValue, oldStep.idx, oldStep.created_at],
            );
          }
        }

        const { rows: oldMessages } = await client.query<{
          id: string;
          step_id: string | null;
          role: LlmMessage['role'];
          content: string | null;
          tool_calls: LlmMessage['toolCalls'] | null;
          tool_call_id: string | null;
          collapsed: string | null;
          summary_of: string[] | null;
          provider_state: LlmMessage['providerState'] | null;
          created_at: string;
        }>(
          isSourceRun
            ? `SELECT * FROM messages WHERE run_id = $1 AND step_id IS NULL AND role = 'user' ORDER BY id LIMIT 1`
            : `SELECT * FROM messages WHERE run_id = $1 ORDER BY id`,
          [oldRun.id],
        );
        for (const oldMessage of oldMessages) {
          const mappedSummaryOf = oldMessage.summary_of
            ?.map((id) => messageIdMap.get(Number(id)))
            .filter((id): id is number => id != null);
          const { rows: inserted } = await client.query<{ id: string }>(
            `INSERT INTO messages (
               thread_id, run_id, step_id, role, content, tool_calls, tool_call_id, collapsed, summary_of, provider_state, created_at
             )
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::bigint[], $10::jsonb, $11)
             RETURNING id`,
            [
              forkThreadId,
              newRunIdValue,
              oldMessage.step_id ? stepIdMap.get(oldMessage.step_id) ?? null : null,
              oldMessage.role,
              oldMessage.content,
              oldMessage.tool_calls ? JSON.stringify(oldMessage.tool_calls) : null,
              oldMessage.tool_call_id,
              oldMessage.collapsed,
              mappedSummaryOf?.length ? mappedSummaryOf : null,
              oldMessage.provider_state ? JSON.stringify(oldMessage.provider_state) : null,
              oldMessage.created_at,
            ],
          );
          messageIdMap.set(Number(oldMessage.id), Number(inserted[0].id));
        }

        if (!isSourceRun) {
          const { rows: oldEvents } = await client.query<{
            step_id: string | null;
            idx: number;
            type: string;
            data: AgentEvent;
            created_at: string;
          }>(
            `SELECT step_id, idx, type, data, created_at FROM events WHERE run_id = $1 ORDER BY id`,
            [oldRun.id],
          );
          for (const oldEvent of oldEvents) {
            await client.query(
              `INSERT INTO events (run_id, step_id, idx, type, data, created_at)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
              [
                newRunIdValue,
                oldEvent.step_id ? stepIdMap.get(oldEvent.step_id) ?? null : null,
                oldEvent.idx,
                oldEvent.type,
                JSON.stringify(oldEvent.data),
                oldEvent.created_at,
              ],
            );
          }
        }
      }

      if (!activeRun) throw new Error('fork 未生成 active run');
      await client.query(`UPDATE threads SET active_run_id = $2, updated_at = now() WHERE id = $1`, [forkThreadId, activeRun.id]);
      const originalMessage = '已从本消息 fork 到新对话。';
      const forkMessage = '此对话 fork 自原对话。';
      const sourceTitle = sourceThread.title ?? '未命名对话';
      await client.query(
        `INSERT INTO thread_notices (thread_id, kind, message, title, linked_thread_id, linked_run_id)
         VALUES ($1, 'fork_to', $2, $3, $4, $5), ($6, 'fork_from', $7, $8, $9, $10)`,
        [
          source.thread_id,
          originalMessage,
          forkTitle,
          forkThreadId,
          sourceRunId,
          forkThreadId,
          forkMessage,
          sourceTitle,
          source.thread_id,
          activeRun.id,
        ],
      );
      await client.query('COMMIT');
      const refreshedThread = await this.getThread(scope, forkThreadId);
      return refreshedThread ? { thread: refreshedThread, activeRun } : { thread: newThread, activeRun };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createRun(scope: Scope, threadId: string, input: string, options: CreateRunOptions = {}): Promise<RunRow> {
    const id = newRunId();
    const row = await prisma.$transaction(async (tx) => {
      const thread = await tx.threads.findFirst({
        where: { id: threadId, tenant_id: scope.tenantId, user_id: scope.userId },
        select: {
          active_run_id: true,
          spaces: {
            select: {
              config: true,
              config_version: true,
              deleted_at: true,
              mode: true,
              space_visible_users: { where: { user_id: scope.userId }, select: { user_id: true } },
            },
          },
        },
      });
      if (!thread) throw new Error('threadId 不存在或不属于当前用户');
      if (thread.spaces.deleted_at) throw new Error('space 已删除，不能创建新 run');
      if (thread.spaces.mode !== 'web') throw new Error('外部空间在 Web 中只读');
      if (
        options.expectedSpaceConfigVersion !== undefined
        && options.expectedSpaceConfigVersion !== thread.spaces.config_version
      ) {
        throw new SpaceConfigChangedError();
      }
      const user = await tx.users.findFirst({
        where: { id: scope.userId, tenant_id: scope.tenantId, status: 'active' },
        select: { role: true },
      });
      const canManage = user?.role === 'owner' || user?.role === 'admin';
      if (!user || (!canManage && thread.spaces.space_visible_users.length === 0)) {
        throw new Error('space 不存在或当前用户不可写');
      }

      let parentRunId = options.parentRunId;
      if (parentRunId === undefined) {
        parentRunId = thread.active_run_id;
        if (!parentRunId) {
          parentRunId = (await tx.runs.findFirst({
            where: { thread_id: threadId },
            select: { id: true },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          }))?.id ?? null;
        }
      }
      if (parentRunId && !await tx.runs.count({ where: { id: parentRunId, thread_id: threadId } })) {
        throw new Error('parentRunId 不属于当前 thread');
      }

      const created = await tx.runs.create({
        data: {
          id,
          thread_id: threadId,
          parent_run_id: parentRunId ?? null,
          status: 'pending',
          input,
          model_ref: options.modelRef ?? null,
          runtime_capabilities_snapshot: nullableJson(options.runtimeCapabilitiesSnapshot),
          space_config_snapshot: requiredJson(options.spaceConfigSnapshot ?? thread.spaces.config),
          space_config_version: thread.spaces.config_version,
          plugin_lock: nullableJson(options.pluginLock),
        },
      });

      // executing_run_id 是 thread 的唯一执行槽。条件更新(CAS)让不同请求在短事务内
      // 竞争，不需要显式行锁；失败时抛错会回滚上面刚创建的 pending run。
      const claimed = await tx.threads.updateMany({
        where: {
          id: threadId,
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          executing_run_id: null,
        },
        data: { executing_run_id: id, active_run_id: id, updated_at: new Date() },
      });
      if (claimed.count === 0) {
        throw await occupiedRunError(tx, threadId);
      }
      return created;
    });
    return toRunRow(row);
  }

  async beginRunExecution(scope: Scope, id: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const run = await tx.runs.findFirst({
        where: {
          id,
          status: { in: ['pending', 'running'] },
          threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
        },
        select: { thread_id: true, space_config_snapshot: true },
      });
      if (!run) return false;
      const claimed = await tx.threads.updateMany({
        where: { id: run.thread_id, OR: [{ executing_run_id: null }, { executing_run_id: id }] },
        data: { executing_run_id: id },
      });
      if (!claimed.count) throw await occupiedRunError(tx, run.thread_id);
      const started = await tx.runs.updateMany({
        where: { id, status: { in: ['pending', 'running'] } },
        data: {
          status: 'running',
          external_input_open: allowsExternalNextStep(run.space_config_snapshot),
          updated_at: new Date(),
        },
      });
      return started.count === 1;
    });
  }

  async getRun(scope: Scope, id: string): Promise<RunRow | null> {
    const row = await prisma.runs.findFirst({
      where: {
        id,
        threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
      },
    });
    return row ? toRunRow(row) : null;
  }

  async listRuns(scope: Scope, threadId: string): Promise<RunRow[]> {
    return (await prisma.runs.findMany({
      where: {
        thread_id: threadId,
        threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
      },
      orderBy: { created_at: 'asc' },
    })).map(toRunRow);
  }

  async listRunsByStatusUnscoped(statuses: RunStatus[]): Promise<RunRow[]> {
    if (!statuses.length) return [];
    return (await prisma.runs.findMany({
      where: { status: { in: statuses } },
      orderBy: [{ updated_at: 'asc' }, { created_at: 'asc' }],
    })).map(toRunRow);
  }

  async setRunStatus(scope: Scope, id: string, status: RunStatus, fields: { output?: string | null; error?: string | null } = {}): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const run = await tx.runs.findFirst({
        where: {
          id,
          threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
        },
        select: { thread_id: true },
      });
      if (!run) return;

      if (!isTerminalRunStatus(status)) {
        const claimed = await tx.threads.updateMany({
          where: {
            id: run.thread_id,
            OR: [{ executing_run_id: null }, { executing_run_id: id }],
          },
          data: { executing_run_id: id },
        });
        if (claimed.count === 0) {
          throw await occupiedRunError(tx, run.thread_id);
        }
      }

      await tx.runs.update({
        where: { id },
        data: {
          status,
          output: Object.prototype.hasOwnProperty.call(fields, 'output') ? fields.output ?? null : undefined,
          error: Object.prototype.hasOwnProperty.call(fields, 'error') ? fields.error ?? null : undefined,
          external_input_open: status === 'pending' || status === 'running' ? undefined : false,
          updated_at: new Date(),
        },
      });

      if (status !== 'pending' && status !== 'running') {
        const now = new Date();
        await tx.run_inputs.updateMany({
          where: { run_id: id, status: 'pending' },
          data: { status: 'canceled', canceled_at: now },
        });
      }

      if (isTerminalRunStatus(status)) {
        // 只允许当前 run 释放自己的槽，旧 run 的迟到收口不能清掉后来启动的 run。
        await tx.threads.updateMany({
          where: { id: run.thread_id, executing_run_id: id },
          data: { executing_run_id: null },
        });
      }
    });
  }

  async applyPendingRunInputs(scope: Scope, id: string): Promise<AppliedRunInput[]> {
    return prisma.$transaction(async (tx) => {
      const run = await tx.runs.findFirst({
        where: {
          id,
          status: { in: ['pending', 'running'] },
          threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
        },
        select: { thread_id: true },
      });
      if (!run) return [];
      return applyPendingRunInputsInTransaction(tx, id, run.thread_id);
    });
  }

  async closeExternalInputAndApplyPending(
    scope: Scope,
    id: string,
  ): Promise<{ closed: boolean; inputs: AppliedRunInput[] }> {
    return prisma.$transaction(async (tx) => {
      const run = await tx.runs.findFirst({
        where: {
          id,
          threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
        },
        select: { thread_id: true },
      });
      if (!run) return { closed: false, inputs: [] };

      // 关闭与 appendNextStep 对同一 run 行做 CAS。两者并发时，数据库只会选定
      // “先接纳后应用”或“先关闭后拒绝”其中一个顺序，不存在成功回执后漏注入。
      const closed = await tx.runs.updateMany({
        where: {
          id,
          status: { in: ['pending', 'running'] },
          external_input_open: true,
        },
        data: { external_input_open: false, updated_at: new Date() },
      });
      if (!closed.count) return { closed: false, inputs: [] };

      const inputs = await applyPendingRunInputsInTransaction(tx, id, run.thread_id);
      if (inputs.length) {
        await tx.runs.updateMany({
          where: { id, status: { in: ['pending', 'running'] } },
          data: { external_input_open: true, updated_at: new Date() },
        });
      }
      return { closed: true, inputs };
    });
  }

  async resumeRun(
    scope: Scope,
    id: string,
    expectedStatuses: RunStatus[],
    fields: { output?: string | null; error?: string | null; userMessageContent?: string } = {},
  ): Promise<RunRow | null> {
    if (!expectedStatuses.length) return null;
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.runs.findFirst({
        where: {
          id,
          threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
        },
        select: {
          status: true,
          thread_id: true,
          threads_runs_thread_idTothreads: { select: { executing_run_id: true } },
        },
      });
      if (!current || !expectedStatuses.includes(current.status as RunStatus)) return null;
      if (current.status === 'pending' && current.threads_runs_thread_idTothreads.executing_run_id === id) {
        throw new RunActiveError(id, 'pending');
      }

      // status 条件与执行槽 CAS 在同一短事务里：两个 continue/answer 并发时只有一个
      // 能把旧状态切成 pending，另一个不会再启动第二个 executor。
      const resumed = await tx.runs.updateMany({
        where: { id, status: { in: expectedStatuses } },
        data: {
          status: 'pending',
          output: Object.prototype.hasOwnProperty.call(fields, 'output') ? fields.output ?? null : undefined,
          error: Object.prototype.hasOwnProperty.call(fields, 'error') ? fields.error ?? null : undefined,
          updated_at: new Date(),
        },
      });
      if (resumed.count === 0) return null;

      const claimed = await tx.threads.updateMany({
        where: {
          id: current.thread_id,
          OR: [{ executing_run_id: null }, { executing_run_id: id }],
        },
        data: { executing_run_id: id },
      });
      if (claimed.count === 0) throw await occupiedRunError(tx, current.thread_id);

      // waiting_for_user 的回答必须和状态 CAS 一起提交；否则进程可能在状态改成
      // pending 后、消息落库前退出，恢复时模型会在没有回答内容的情况下继续。
      if (fields.userMessageContent !== undefined) {
        await tx.messages.create({
          data: {
            thread_id: current.thread_id,
            run_id: id,
            role: 'user',
            content: fields.userMessageContent,
          },
        });
      }

      return tx.runs.findUnique({ where: { id } });
    });
    return row ? toRunRow(row) : null;
  }

  async setGoalState(scope: Scope, runId: string, goal: GoalState): Promise<void> {
    await prisma.runs.updateMany({
      where: {
        id: runId,
        threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
      },
      data: { goal_state: requiredJson(goal), updated_at: new Date() },
    });
  }

  async setRuntimeCapabilitiesSnapshot(
    scope: Scope,
    runId: string,
    snapshot: object,
  ): Promise<void> {
    await prisma.runs.updateMany({
      where: {
        id: runId,
        threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId },
      },
      data: { runtime_capabilities_snapshot: requiredJson(snapshot), updated_at: new Date() },
    });
  }

  async getRunUnscoped(id: string): Promise<RunRow | null> {
    const row = await prisma.runs.findUnique({ where: { id } });
    return row ? toRunRow(row) : null;
  }

  async getThreadUnscoped(id: string): Promise<ThreadRow | null> {
    const row = await prisma.threads.findUnique({ where: { id } });
    return row ? toThreadRow(row) : null;
  }

  async createStep(scope: Scope, runId: string, idx: number): Promise<StepRow> {
    if (!(await this.runBelongsToScope(scope, runId))) throw new Error('runId 不存在或不属于当前用户');
    return toStepRow(await prisma.steps.create({ data: { id: newStepId(), run_id: runId, idx } }));
  }

  async getLastStepIndex(scope: Scope, runId: string): Promise<number> {
    if (!(await this.runBelongsToScope(scope, runId))) return 0;
    return (await prisma.steps.aggregate({ where: { run_id: runId }, _max: { idx: true } }))._max.idx ?? 0;
  }

  async getLastCompletedStepIndex(scope: Scope, runId: string): Promise<number> {
    const owns = await this.runBelongsToScope(scope, runId);
    if (!owns) return 0;
    let last = 0;
    const steps = await prisma.steps.findMany({
      where: { run_id: runId },
      select: {
        idx: true,
        messages: {
          select: { role: true, tool_calls: true, tool_call_id: true },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { idx: 'asc' },
    });
    for (const step of steps) {
      const assistantRows = step.messages.filter((row) => row.role === 'assistant');
      if (!assistantRows.length) continue;
      const requiredToolIds = assistantRows.flatMap((row) => {
        const calls = (row.tool_calls ?? []) as unknown as NonNullable<LlmMessage['toolCalls']>;
        return calls.map((call) => call.id);
      });
      const answeredToolIds = new Set(step.messages
        .filter((row) => row.role === 'tool' && row.tool_call_id)
        .map((row) => row.tool_call_id as string));
      if (requiredToolIds.every((id) => answeredToolIds.has(id))) last = Math.max(last, step.idx);
    }
    return last;
  }

  async loadThreadMessages(scope: Scope, threadId: string, options: { runId?: string | null } = {}): Promise<ThreadMessage[]> {
    const visibleRunIds = await this.visibleRunIds(scope, threadId, options.runId);
    if (!visibleRunIds?.length) return [];
    const rows = await prisma.messages.findMany({
      where: { thread_id: threadId, run_id: { in: visibleRunIds } },
      select: {
        id: true,
        role: true,
        content: true,
        tool_calls: true,
        tool_call_id: true,
        collapsed: true,
        summary_of: true,
        provider_state: true,
      },
      orderBy: { id: 'asc' },
    });
    // Build the compacted LLM-facing view. The original content/tool args stay in
    // the DB; masked rows render placeholders, summarized rows are folded out.
    const messages = rows
      .filter((r) => r.collapsed !== 'summarized'
        && !isEphemeralSystemMessage(r.role as LlmMessage['role'], r.content))
      .sort((a, b) => Number(a.summary_of[0] ?? a.id) - Number(b.summary_of[0] ?? b.id))
      .map((r) => ({
        id: serialId(r.id),
        role: r.role as LlmMessage['role'],
        content: r.collapsed === 'masked' && r.role === 'tool' ? maskPlaceholder(r.content ?? '') : r.content,
        toolCalls:
          r.collapsed === 'masked' && r.role === 'assistant' && r.tool_calls
            ? maskToolCallArguments(r.tool_calls as unknown as NonNullable<LlmMessage['toolCalls']>).calls
            : (r.tool_calls as unknown as LlmMessage['toolCalls'] ?? undefined),
        toolCallId: r.tool_call_id ?? undefined,
        providerState: r.collapsed === 'masked'
          ? undefined
          : (r.provider_state as unknown as LlmMessage['providerState'] ?? undefined),
        collapsed: r.collapsed as ThreadMessage['collapsed'] ?? undefined,
      }));
    return sanitizeThreadMessagesForModel(messages);
  }

  async loadThreadMessageMetadata(scope: Scope, threadId: string, options: { runId?: string | null } = {}): Promise<ThreadMessageMetadata[]> {
    const visibleRunIds = await this.visibleRunIds(scope, threadId, options.runId);
    if (!visibleRunIds?.length) return [];
    const rows = await prisma.$queryRaw<Array<{
      id: bigint;
      run_id: string;
      step_id: string | null;
      role: LlmMessage['role'];
      tool_calls: Array<{ id: string; name: string; argumentChars: number }>;
      tool_call_id: string | null;
      collapsed: 'masked' | 'summarized';
      summary_of: bigint[] | null;
      content_chars: number;
      created_at: Date;
    }>>(Prisma.sql`
      SELECT m.id, m.run_id, m.step_id, m.role, m.tool_call_id, m.collapsed, m.summary_of,
             length(COALESCE(m.content, ''))::int AS content_chars,
             m.created_at,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', call->>'id',
                 'name', call->>'name',
                 'argumentChars', length(COALESCE(call->>'arguments', ''))
               ))
               FROM jsonb_array_elements(COALESCE(m.tool_calls, '[]'::jsonb)) call
             ), '[]'::jsonb) AS tool_calls
      FROM messages m
      WHERE m.thread_id = ${threadId}
        AND m.run_id IN (${Prisma.join(visibleRunIds)})
        AND m.collapsed IS NOT NULL
      ORDER BY m.id
    `);
    return rows.map((row) => ({
      id: serialId(row.id),
      run_id: row.run_id,
      step_id: row.step_id,
      role: row.role,
      toolCalls: row.tool_calls,
      toolCallId: row.tool_call_id,
      collapsed: row.collapsed,
      summaryOf: (row.summary_of ?? []).map(serialId),
      contentChars: row.content_chars,
      created_at: row.created_at.toISOString(),
    }));
  }

  async loadRawThreadMessages(scope: Scope, threadId: string, options: { runId?: string | null } = {}): Promise<RawThreadMessage[]> {
    const visibleRunIds = await this.visibleRunIds(scope, threadId, options.runId);
    if (!visibleRunIds?.length) return [];
    const rows = await prisma.messages.findMany({
      where: { thread_id: threadId, run_id: { in: visibleRunIds } },
      orderBy: { id: 'asc' },
    });
    return rows
      .filter((row) => !isEphemeralSystemMessage(row.role as LlmMessage['role'], row.content))
      .map((row) => ({
        id: serialId(row.id),
        run_id: row.run_id,
        step_id: row.step_id,
        role: row.role as LlmMessage['role'],
        content: row.content,
        toolCalls: row.tool_calls as unknown as LlmMessage['toolCalls'] ?? undefined,
        toolCallId: row.tool_call_id ?? undefined,
        providerState: row.provider_state as unknown as LlmMessage['providerState'] ?? undefined,
        collapsed: row.collapsed as RawThreadMessage['collapsed'] ?? undefined,
        summaryOf: row.summary_of.map(serialId),
        created_at: row.created_at.toISOString(),
      }));
  }

  async addMessage(scope: Scope, threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number> {
    if (!(await this.runBelongsToScope(scope, runId, threadId))) {
      throw new Error('threadId/runId 不存在、不匹配或不属于当前用户');
    }
    if (stepId && !await prisma.steps.count({ where: { id: stepId, run_id: runId } })) {
      throw new Error('stepId 不属于当前 run');
    }
    const row = await prisma.messages.create({
      data: {
        thread_id: threadId,
        run_id: runId,
        step_id: stepId,
        role: msg.role,
        content: msg.content,
        tool_calls: nullableJson(msg.toolCalls),
        tool_call_id: msg.toolCallId ?? null,
        provider_state: nullableJson(msg.providerState),
      },
      select: { id: true },
    });
    return serialId(row.id);
  }

  async countRunMessages(scope: Scope, runId: string): Promise<number> {
    return prisma.messages.count({
      where: { run_id: runId, threads: { tenant_id: scope.tenantId, user_id: scope.userId } },
    });
  }

  async addSummaryMessage(
    scope: Scope,
    threadId: string,
    runId: string,
    stepId: string | null,
    msg: LlmMessage,
    summaryOf: number[],
  ): Promise<number> {
    if (!(await this.runBelongsToScope(scope, runId, threadId))) {
      throw new Error('threadId/runId 不存在、不匹配或不属于当前用户');
    }
    if (stepId && !await prisma.steps.count({ where: { id: stepId, run_id: runId } })) {
      throw new Error('stepId 不属于当前 run');
    }
    const row = await prisma.messages.create({
      data: {
        thread_id: threadId,
        run_id: runId,
        step_id: stepId,
        role: msg.role,
        content: msg.content,
        tool_calls: nullableJson(msg.toolCalls),
        tool_call_id: msg.toolCallId ?? null,
        summary_of: summaryOf.map(BigInt),
        provider_state: nullableJson(msg.providerState),
      },
      select: { id: true },
    });
    return serialId(row.id);
  }

  async markMessagesCollapsed(scope: Scope, ids: number[], kind: 'masked' | 'summarized'): Promise<void> {
    if (!ids.length) return;
    await prisma.messages.updateMany({
      where: {
        id: { in: ids.map(BigInt) },
        threads: { tenant_id: scope.tenantId, user_id: scope.userId },
      },
      data: { collapsed: kind },
    });
  }

  async addEvent(scope: Scope, runId: string, stepId: string | null, event: AgentEvent): Promise<void> {
    const idx = 'step' in event ? event.step : 0;
    if (!(await this.runBelongsToScope(scope, runId))) return;
    if (stepId && !await prisma.steps.count({ where: { id: stepId, run_id: runId } })) {
      throw new Error('stepId 不属于当前 run');
    }
    await prisma.events.create({
      data: { run_id: runId, step_id: stepId, idx, type: event.type, data: requiredJson(event) },
    });
  }

  async getEvents(scope: Scope, runId: string): Promise<AgentEvent[]> {
    return (await this.getEventsAfterCursor(scope, runId, 0)).map((row) => row.event);
  }

  async getEventsAfterCursor(scope: Scope, runId: string, cursor: number): Promise<StoredEvent[]> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return [];
    return (await prisma.events.findMany({
      where: {
        run_id: runId,
        id: { gt: BigInt(cursor) },
        runs: { threads_runs_thread_idTothreads: { tenant_id: scope.tenantId, user_id: scope.userId } },
      },
      select: { id: true, data: true },
      orderBy: { id: 'asc' },
    })).map((row) => ({
      cursor: serialId(row.id),
      event: row.data as unknown as AgentEvent,
    }));
  }

  async createSubagentRun(scope: Scope, input: {
    parentRunId: string;
    parentStepId?: string | null;
    workflowId?: string | null;
    stageId?: string | null;
    runtimeProfileId?: string | null;
    taskAssignment: Record<string, unknown>;
    skillNames?: string[];
  }): Promise<SubagentRunRow> {
    const id = newSubagentRunId();
    const { rows } = await query<SubagentRunRow>(
      `INSERT INTO subagent_runs (
         id, tenant_id, parent_run_id, parent_step_id, workflow_id, stage_id, runtime_profile_id,
         status, task_assignment, skill_names
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, 'running', $8::jsonb, $9::text[]
       WHERE EXISTS (
         SELECT 1 FROM runs r JOIN threads t ON t.id = r.thread_id
         WHERE r.id = $3 AND t.tenant_id = $2 AND t.user_id = $10
       )
       RETURNING *`,
      [
        id,
        scope.tenantId,
        input.parentRunId,
        input.parentStepId ?? null,
        input.workflowId ?? null,
        input.stageId ?? null,
        input.runtimeProfileId ?? null,
        JSON.stringify(input.taskAssignment),
        input.skillNames ?? [],
        scope.userId,
      ],
    );
    if (!rows.length) throw new Error('parentRunId 不存在或不属于当前用户');
    return rows[0];
  }

  async finishSubagentRun(
    scope: Scope,
    id: string,
    fields: { status: 'done' | 'error'; output?: string | null; error?: string | null; usage?: Record<string, unknown> | null },
  ): Promise<void> {
    await query(
      `UPDATE subagent_runs sr
       SET status = $2, output = $3, error = $4, usage = $5::jsonb, updated_at = now(), finished_at = now()
       WHERE sr.id = $1
         AND sr.parent_run_id IN (
           SELECT r.id FROM runs r JOIN threads t ON t.id = r.thread_id WHERE t.tenant_id = $6 AND t.user_id = $7
         )`,
      [
        id,
        fields.status,
        fields.output ?? null,
        fields.error ?? null,
        fields.usage ? JSON.stringify(fields.usage) : null,
        scope.tenantId,
        scope.userId,
      ],
    );
  }

  async getSubagentRun(scope: Scope, id: string): Promise<SubagentRunRow | null> {
    const { rows } = await query<SubagentRunRow>(
      `SELECT sr.* FROM subagent_runs sr
       JOIN runs r ON r.id = sr.parent_run_id JOIN threads t ON t.id = r.thread_id
       WHERE sr.id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [id, scope.tenantId, scope.userId],
    );
    return rows[0] ?? null;
  }

  async listSubagentRunsByThread(scope: Scope, threadId: string): Promise<SubagentRunRow[]> {
    const { rows } = await query<SubagentRunRow>(
      `SELECT sr.*
       FROM subagent_runs sr
       JOIN runs r ON r.id = sr.parent_run_id
       JOIN threads t ON t.id = r.thread_id
       WHERE r.thread_id = $1 AND t.tenant_id = $2 AND t.user_id = $3
       ORDER BY sr.created_at`,
      [threadId, scope.tenantId, scope.userId],
    );
    return rows;
  }

  async createShellSession(scope: Scope, input: {
    threadId: string;
    name: string;
    owner: ShellSessionRow['owner'];
    workspaceRoot: string;
    cwd?: string;
    backend: string;
    configSnapshot?: Record<string, unknown> | null;
  }): Promise<ShellSessionRow> {
    const id = newShellSessionId();
    const { rows } = await query<ShellSessionRow>(
      `INSERT INTO shell_sessions (id, tenant_id, thread_id, name, owner, workspace_root, cwd, backend, status, config_snapshot)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'idle', $9::jsonb
       WHERE EXISTS (SELECT 1 FROM threads WHERE id = $3 AND tenant_id = $2 AND user_id = $10)
       RETURNING *`,
      [
        id,
        scope.tenantId,
        input.threadId,
        input.name,
        input.owner,
        input.workspaceRoot,
        input.cwd ?? input.workspaceRoot,
        input.backend,
        input.configSnapshot ? JSON.stringify(input.configSnapshot) : null,
        scope.userId,
      ],
    );
    if (!rows.length) throw new Error('threadId 不存在或不属于当前用户');
    return rows[0];
  }

  async getShellSession(scope: Scope, id: string): Promise<ShellSessionRow | null> {
    const { rows } = await query<ShellSessionRow>(
      `SELECT ss.* FROM shell_sessions ss JOIN threads t ON t.id = ss.thread_id
       WHERE ss.id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [id, scope.tenantId, scope.userId],
    );
    return rows[0] ?? null;
  }

  async listShellSessions(scope: Scope, threadId: string, workspaceRoot?: string): Promise<ShellSessionRow[]> {
    const base = `SELECT ss.* FROM shell_sessions ss JOIN threads t ON t.id = ss.thread_id
      WHERE ss.thread_id = $1 AND t.tenant_id = $2 AND t.user_id = $3 AND ss.deleted_at IS NULL`;
    const { rows } = workspaceRoot
      ? await query<ShellSessionRow>(
          `${base} AND ss.workspace_root = $4 ORDER BY ss.updated_at DESC, ss.created_at DESC`,
          [threadId, scope.tenantId, scope.userId, workspaceRoot],
        )
      : await query<ShellSessionRow>(
          `${base} ORDER BY ss.updated_at DESC, ss.created_at DESC`,
          [threadId, scope.tenantId, scope.userId],
        );
    return rows;
  }

  async updateShellSession(
    scope: Scope,
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([key], i) => `${key} = $${i + 2}${key === 'config_snapshot' ? '::jsonb' : ''}`);
    const scopeParamStart = entries.length + 2;
    await query(
      `UPDATE shell_sessions SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND thread_id IN (SELECT id FROM threads WHERE tenant_id = $${scopeParamStart} AND user_id = $${scopeParamStart + 1})`,
      [
        id,
        ...entries.map(([key, value]) => key === 'config_snapshot' && value != null ? JSON.stringify(value) : value),
        scope.tenantId,
        scope.userId,
      ],
    );
  }

  async createShellCommand(scope: Scope, input: {
    sessionId: string;
    runId?: string | null;
    stepId?: string | null;
    actor: ShellActor;
    command: string;
    cwd: string;
    waitMode: 'foreground' | 'background';
    softTimeoutMs?: number | null;
    hardTimeoutMs?: number | null;
    softTimeoutAt?: string | null;
    hardTimeoutAt?: string | null;
  }): Promise<ShellCommandRow> {
    const id = newShellCommandId();
    const { rows } = await query<ShellCommandRow>(
      `INSERT INTO shell_commands (
         id, session_id, run_id, step_id, actor, command, cwd, wait_mode, status,
         soft_timeout_ms, hard_timeout_ms, soft_timeout_at, hard_timeout_at
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, $12
       WHERE EXISTS (
         SELECT 1 FROM shell_sessions ss JOIN threads t ON t.id = ss.thread_id
         WHERE ss.id = $2 AND t.tenant_id = $13 AND t.user_id = $14
       )
       RETURNING *`,
      [
        id,
        input.sessionId,
        input.runId ?? null,
        input.stepId ?? null,
        input.actor,
        input.command,
        input.cwd,
        input.waitMode,
        input.softTimeoutMs ?? null,
        input.hardTimeoutMs ?? null,
        input.softTimeoutAt ?? null,
        input.hardTimeoutAt ?? null,
        scope.tenantId,
        scope.userId,
      ],
    );
    if (!rows.length) throw new Error('sessionId 不存在或不属于当前用户');
    return rows[0];
  }

  async getShellCommand(scope: Scope, id: string): Promise<ShellCommandRow | null> {
    const { rows } = await query<ShellCommandRow>(
      `SELECT sc.* FROM shell_commands sc
       JOIN shell_sessions ss ON ss.id = sc.session_id JOIN threads t ON t.id = ss.thread_id
       WHERE sc.id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [id, scope.tenantId, scope.userId],
    );
    return rows[0] ?? null;
  }

  async listShellCommandsBySession(scope: Scope, sessionId: string, limit = 20): Promise<ShellCommandRow[]> {
    const { rows } = await query<ShellCommandRow>(
      `SELECT sc.* FROM shell_commands sc
       JOIN shell_sessions ss ON ss.id = sc.session_id JOIN threads t ON t.id = ss.thread_id
       WHERE sc.session_id = $1 AND t.tenant_id = $2 AND t.user_id = $3
       ORDER BY sc.started_at DESC LIMIT $4`,
      [sessionId, scope.tenantId, scope.userId, limit],
    );
    return rows;
  }

  async listRunningShellCommandsByRun(scope: Scope, runId: string): Promise<ShellCommandRow[]> {
    const { rows } = await query<ShellCommandRow>(
      `SELECT sc.* FROM shell_commands sc
       JOIN runs r ON r.id = sc.run_id JOIN threads t ON t.id = r.thread_id
       WHERE sc.run_id = $1 AND sc.status = 'running' AND t.tenant_id = $2 AND t.user_id = $3
       ORDER BY sc.started_at`,
      [runId, scope.tenantId, scope.userId],
    );
    return rows;
  }

  async listRunningShellCommandsUnscoped(): Promise<ShellCommandRow[]> {
    const { rows } = await query<ShellCommandRow>(
      `SELECT * FROM shell_commands WHERE status IN ('queued', 'running') ORDER BY updated_at`,
    );
    return rows;
  }

  async updateShellCommandUnscoped(
    id: string,
    fields: Partial<
      Pick<
        ShellCommandRow,
        | 'status'
        | 'attention'
        | 'host_pid'
        | 'child_pid'
        | 'exit_code'
        | 'signal'
        | 'last_output_at'
        | 'output_bytes'
        | 'error'
        | 'ended_at'
      >
    >,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([key], i) => `${key} = $${i + 2}`);
    await query(`UPDATE shell_commands SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [
      id,
      ...entries.map(([, value]) => value),
    ]);
  }

  async updateShellSessionUnscoped(
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([key], i) => `${key} = $${i + 2}${key === 'config_snapshot' ? '::jsonb' : ''}`);
    await query(`UPDATE shell_sessions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [
      id,
      ...entries.map(([key, value]) => key === 'config_snapshot' && value != null ? JSON.stringify(value) : value),
    ]);
  }

  async updateShellCommand(
    scope: Scope,
    id: string,
    fields: Partial<
      Pick<
        ShellCommandRow,
        | 'status'
        | 'attention'
        | 'host_pid'
        | 'child_pid'
        | 'exit_code'
        | 'signal'
        | 'last_output_at'
        | 'output_bytes'
        | 'error'
        | 'ended_at'
      >
    >,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([key], i) => `${key} = $${i + 2}`);
    const scopeParamStart = entries.length + 2;
    await query(
      `UPDATE shell_commands SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND session_id IN (
         SELECT ss.id FROM shell_sessions ss JOIN threads t ON t.id = ss.thread_id
         WHERE t.tenant_id = $${scopeParamStart} AND t.user_id = $${scopeParamStart + 1}
       )`,
      [id, ...entries.map(([, value]) => value), scope.tenantId, scope.userId],
    );
  }

  async appendShellCommandLog(scope: Scope, commandId: string, stream: ShellLogStream, chunk: string): Promise<ShellCommandLogRow> {
    const { rows } = await query<ShellCommandLogRow>(
      `WITH next_seq AS (
         SELECT COALESCE(max(seq), 0) + 1 AS seq FROM shell_command_logs WHERE command_id = $1
       )
       INSERT INTO shell_command_logs (command_id, seq, stream, chunk)
       SELECT $1, seq, $2, $3 FROM next_seq
       WHERE EXISTS (
         SELECT 1 FROM shell_commands sc
         JOIN shell_sessions ss ON ss.id = sc.session_id JOIN threads t ON t.id = ss.thread_id
         WHERE sc.id = $1 AND t.tenant_id = $4 AND t.user_id = $5
       )
       RETURNING *`,
      [commandId, stream, chunk, scope.tenantId, scope.userId],
    );
    if (!rows.length) throw new Error('commandId 不存在或不属于当前用户');
    return rows[0];
  }

  async getShellCommandLogs(scope: Scope, commandId: string, sinceSeq = 0, limit = 200): Promise<ShellCommandLogRow[]> {
    const { rows } = await query<ShellCommandLogRow>(
      `SELECT scl.* FROM shell_command_logs scl
       JOIN shell_commands sc ON sc.id = scl.command_id
       JOIN shell_sessions ss ON ss.id = sc.session_id JOIN threads t ON t.id = ss.thread_id
       WHERE scl.command_id = $1 AND scl.seq > $2 AND t.tenant_id = $4 AND t.user_id = $5
       ORDER BY scl.seq LIMIT $3`,
      [commandId, sinceSeq, limit, scope.tenantId, scope.userId],
    );
    return rows;
  }

  async addShellSessionEvent(scope: Scope, sessionId: string, actor: ShellActor, kind: string, data: unknown): Promise<void> {
    await query(
      `INSERT INTO shell_session_events (session_id, actor, kind, data)
       SELECT $1, $2, $3, $4
       WHERE EXISTS (
         SELECT 1 FROM shell_sessions ss JOIN threads t ON t.id = ss.thread_id
         WHERE ss.id = $1 AND t.tenant_id = $5 AND t.user_id = $6
       )`,
      [sessionId, actor, kind, JSON.stringify(data ?? {}), scope.tenantId, scope.userId],
    );
  }

  async upsertPushSubscription(scope: Scope, input: WebPushSubscriptionInput, userAgent?: string | null): Promise<PushSubscriptionRow> {
    const expiresAt = input.expirationTime ? new Date(input.expirationTime).toISOString() : null;
    const { rows } = await query<PushSubscriptionRow>(
      `INSERT INTO push_subscriptions (endpoint, tenant_id, user_id, p256dh, auth, expiration_time, user_agent, enabled, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, NULL)
       ON CONFLICT (endpoint) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           expiration_time = EXCLUDED.expiration_time,
           user_agent = EXCLUDED.user_agent,
           enabled = true,
           last_error = NULL,
           updated_at = now()
       RETURNING *`,
      [input.endpoint, scope.tenantId, scope.userId, input.keys.p256dh, input.keys.auth, expiresAt, userAgent ?? null],
    );
    return rows[0];
  }

  async listEnabledPushSubscriptionsByScope(scope: Scope): Promise<PushSubscriptionRow[]> {
    const { rows } = await query<PushSubscriptionRow>(
      `SELECT * FROM push_subscriptions WHERE enabled = true AND tenant_id = $1 AND user_id = $2 ORDER BY updated_at DESC`,
      [scope.tenantId, scope.userId],
    );
    return rows;
  }

  async disablePushSubscription(endpoint: string, error?: string | null): Promise<void> {
    await query(
      `UPDATE push_subscriptions
       SET enabled = false, last_error = $2, updated_at = now()
       WHERE endpoint = $1`,
      [endpoint, error ?? null],
    );
  }

  async createTenantWithOwner(input: CreateTenantWithOwnerInput) {
    const ownerId = newUserId();
    const defaultSpaceId = newSpaceId();
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenants.create({
        data: { id: input.id, name: input.name, is_bootstrap: input.isBootstrap ?? false },
      });
      const owner = await tx.users.create({
        data: {
          id: ownerId,
          tenant_id: input.id,
          email: input.ownerEmail,
          password_hash: input.ownerPasswordHash,
          role: 'owner',
        },
      });

      // tenant 只写入自己的静态初始配置。LLM、MCP、运行时、工具和数据源由系统统一维护，
      // 不能复制 bootstrap tenant 中的系统凭证或资源配置。
      const settings = new Map(input.settingsTemplate.map((entry) => [entry.key, entry.value]));
      if (settings.size) {
        await tx.app_settings.createMany({
          data: [...settings].map(([key, value]) => ({
            tenant_id: input.id,
            key,
            value: requiredJson(value),
          })),
        });
      }

      const defaultSpace = await tx.spaces.create({
        data: {
          id: defaultSpaceId,
          tenant_id: input.id,
          mode: 'web',
          name: 'Default',
          config: requiredJson(input.defaultSpaceConfig ?? {}),
          created_by_user_id: owner.id,
        },
      });
      const provisionedTenant = await tx.tenants.update({
        where: { id: input.id },
        data: { default_space_id: defaultSpace.id },
      });
      return { tenant: provisionedTenant, owner, defaultSpace };
    });
    return {
      tenant: toTenantRow(result.tenant),
      owner: toUserRow(result.owner),
      defaultSpace: toSpaceRow(result.defaultSpace),
    };
  }

  async findTenant(id: string): Promise<TenantRow | null> {
    const row = await prisma.tenants.findUnique({ where: { id } });
    return row ? toTenantRow(row) : null;
  }

  async findBootstrapTenant(): Promise<TenantRow | null> {
    const rows = await prisma.tenants.findMany({ where: { is_bootstrap: true }, take: 2 });
    if (rows.length > 1) throw new Error('数据库中存在多个 bootstrap tenant');
    return rows[0] ? toTenantRow(rows[0]) : null;
  }

  async migrateBootstrapTenantId(currentId: string, nextId: string): Promise<TenantRow> {
    const row = await prisma.tenants.update({
      where: { id: currentId },
      data: { id: nextId, is_bootstrap: true },
    });
    return toTenantRow(row);
  }

  async listTenants(): Promise<TenantRow[]> {
    return (await prisma.tenants.findMany({ orderBy: { created_at: 'asc' } })).map(toTenantRow);
  }

  async updateTenantStatus(id: string, status: 'active' | 'suspended'): Promise<TenantRow | null> {
    const [row] = await prisma.tenants.updateManyAndReturn({ where: { id }, data: { status } });
    return row ? toTenantRow(row) : null;
  }

  async getDefaultSpace(tenantId: string): Promise<SpaceRow | null> {
    const tenant = await prisma.tenants.findUnique({
      where: { id: tenantId },
      select: { default_space: true },
    });
    return tenant?.default_space ? toSpaceRow(tenant.default_space) : null;
  }

  async listSpaces(tenantId: string, options: { includeDeleted?: boolean } = {}): Promise<SpaceWithVisibilityRow[]> {
    const rows = await prisma.spaces.findMany({
      where: { tenant_id: tenantId, ...(options.includeDeleted ? {} : { deleted_at: null }) },
      include: { space_visible_users: { select: { user_id: true } } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toSpaceWithVisibility);
  }

  async findSpace(tenantId: string, id: string): Promise<SpaceWithVisibilityRow | null> {
    const row = await prisma.spaces.findFirst({
      where: { id, tenant_id: tenantId },
      include: { space_visible_users: { select: { user_id: true } } },
    });
    return row ? toSpaceWithVisibility(row) : null;
  }

  async createSpace(input: CreateSpaceRecordInput): Promise<SpaceWithVisibilityRow> {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.spaces.create({
        data: {
          id: newSpaceId(),
          tenant_id: input.tenantId,
          mode: input.mode,
          name: input.name,
          execution_user_id: input.executionUserId,
          config: requiredJson(input.config),
          created_by_user_id: input.createdByUserId,
        },
      });
      if (input.visibleUserIds.length) {
        await tx.space_visible_users.createMany({
          data: input.visibleUserIds.map((userId) => ({
            space_id: created.id,
            user_id: userId,
            tenant_id: input.tenantId,
          })),
        });
      }
      return tx.spaces.findUniqueOrThrow({
        where: { id: created.id },
        include: { space_visible_users: { select: { user_id: true } } },
      });
    });
    return toSpaceWithVisibility(row);
  }

  async updateSpace(
    tenantId: string,
    id: string,
    fields: UpdateSpaceRecordInput,
  ): Promise<SpaceWithVisibilityRow | null> {
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.spaces.findFirst({ where: { id, tenant_id: tenantId } });
      if (!current) return null;
      const updated = await tx.spaces.updateMany({
        // Service 层先给出“已删除，请先恢复”的稳定错误；这里的 deleted_at 条件处理
        // 更新与软删除并发的窄窗口，避免已经删除的空间被随后到达的更新写穿。
        where: { id, tenant_id: tenantId, deleted_at: null },
        data: {
          name: fields.name,
          execution_user_id: fields.executionUserId !== undefined
            ? fields.executionUserId ?? null
            : undefined,
          config: fields.config === undefined ? undefined : requiredJson(fields.config),
          config_version: fields.config === undefined ? undefined : { increment: 1 },
          updated_at: new Date(),
        },
      });
      if (updated.count === 0) return null;
      if (fields.visibleUserIds !== undefined) {
        await tx.space_visible_users.deleteMany({ where: { space_id: id } });
        if (fields.visibleUserIds.length) {
          await tx.space_visible_users.createMany({
            data: fields.visibleUserIds.map((userId) => ({ space_id: id, user_id: userId, tenant_id: tenantId })),
          });
        }
      }
      return tx.spaces.findUniqueOrThrow({
        where: { id },
        include: { space_visible_users: { select: { user_id: true } } },
      });
    });
    return row ? toSpaceWithVisibility(row) : null;
  }

  async softDeleteSpaceAndRevokeTokens(tenantId: string, id: string): Promise<SpaceWithVisibilityRow | null> {
    const row = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenants.findUnique({ where: { id: tenantId }, select: { default_space_id: true } });
      const current = await tx.spaces.findFirst({ where: { id, tenant_id: tenantId } });
      if (!current) return null;
      if (tenant?.default_space_id === id) throw new DefaultSpaceImmutableError('default 空间不能删除');
      const now = new Date();
      await tx.spaces.update({
        where: { id },
        data: { deleted_at: current.deleted_at ?? now, updated_at: now },
      });
      await tx.external_tokens.updateMany({
        where: {
          revoked_at: null,
          external_callers: { space_id: id, tenant_id: tenantId },
        },
        data: { revoked_at: now },
      });
      return tx.spaces.findUniqueOrThrow({
        where: { id },
        include: { space_visible_users: { select: { user_id: true } } },
      });
    });
    return row ? toSpaceWithVisibility(row) : null;
  }

  async restoreSpace(tenantId: string, id: string): Promise<SpaceWithVisibilityRow | null> {
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.spaces.updateMany({
        where: { id, tenant_id: tenantId },
        data: { deleted_at: null, updated_at: new Date() },
      });
      if (updated.count === 0) return null;
      return tx.spaces.findUniqueOrThrow({
        where: { id },
        include: { space_visible_users: { select: { user_id: true } } },
      });
    });
    return row ? toSpaceWithVisibility(row) : null;
  }

  async createUser(input: { tenantId: string; email: string; passwordHash: string; role: TenantUserRole }): Promise<UserRow> {
    return toUserRow(await prisma.users.create({
      data: {
        id: newUserId(),
        tenant_id: input.tenantId,
        email: input.email,
        password_hash: input.passwordHash,
        role: input.role,
      },
    }));
  }

  async findUserByEmail(tenantId: string, email: string): Promise<UserRow | null> {
    const row = await prisma.users.findUnique({ where: { tenant_id_email: { tenant_id: tenantId, email } } });
    return row ? toUserRow(row) : null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const row = await prisma.users.findUnique({ where: { id } });
    return row ? toUserRow(row) : null;
  }

  async listUsersByTenant(tenantId: string): Promise<UserRow[]> {
    return (await prisma.users.findMany({ where: { tenant_id: tenantId }, orderBy: { created_at: 'asc' } })).map(toUserRow);
  }

  async updateUserRole(id: string, role: TenantUserRole): Promise<UserRow | null> {
    const [row] = await prisma.users.updateManyAndReturn({ where: { id }, data: { role } });
    return row ? toUserRow(row) : null;
  }

  async updateUserStatus(id: string, status: 'active' | 'disabled'): Promise<UserRow | null> {
    const [row] = await prisma.users.updateManyAndReturn({ where: { id }, data: { status } });
    return row ? toUserRow(row) : null;
  }

  async updateUser(
    id: string,
    fields: { email?: string; passwordHash?: string; role?: TenantUserRole; status?: 'active' | 'disabled' },
  ): Promise<UserRow | null> {
    const [row] = await prisma.users.updateManyAndReturn({
      where: { id },
      data: {
        email: fields.email,
        password_hash: fields.passwordHash,
        role: fields.role,
        status: fields.status,
      },
    });
    return row ? toUserRow(row) : null;
  }

  async revokeRefreshTokensByUser(userId: string): Promise<void> {
    await prisma.auth_tokens.updateMany({
      where: { user_id: userId, kind: 'refresh', revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  async createAuthToken(input: {
    tenantId: string;
    userId: string;
    kind: 'refresh' | 'api';
    tokenHash: string;
    label?: string | null;
    expiresAt?: string | null;
  }): Promise<AuthTokenRow> {
    return toAuthTokenRow(await prisma.auth_tokens.create({
      data: {
        id: newAuthTokenId(),
        tenant_id: input.tenantId,
        user_id: input.userId,
        kind: input.kind,
        token_hash: input.tokenHash,
        label: input.label ?? null,
        expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    }));
  }

  async findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRow | null> {
    const row = await prisma.auth_tokens.findUnique({ where: { token_hash: tokenHash } });
    return row ? toAuthTokenRow(row) : null;
  }

  async revokeAuthToken(id: string): Promise<void> {
    await prisma.auth_tokens.updateMany({ where: { id, revoked_at: null }, data: { revoked_at: new Date() } });
  }

  async listApiTokensByTenant(tenantId: string): Promise<AuthTokenRow[]> {
    return (await prisma.auth_tokens.findMany({
      where: { tenant_id: tenantId, kind: 'api' },
      orderBy: { created_at: 'desc' },
    })).map(toAuthTokenRow);
  }

  async createSystemAdmin(input: { email: string; passwordHash: string }): Promise<SystemAdminRow> {
    return toSystemAdminRow(await prisma.system_admins.create({
      data: { id: newSystemAdminId(), email: input.email, password_hash: input.passwordHash },
    }));
  }

  async findSystemAdminByEmail(email: string): Promise<SystemAdminRow | null> {
    const row = await prisma.system_admins.findUnique({ where: { email } });
    return row ? toSystemAdminRow(row) : null;
  }

  async findSystemAdminById(id: string): Promise<SystemAdminRow | null> {
    const row = await prisma.system_admins.findUnique({ where: { id } });
    return row ? toSystemAdminRow(row) : null;
  }

  async listSystemAdmins(): Promise<SystemAdminRow[]> {
    return (await prisma.system_admins.findMany({ orderBy: { created_at: 'asc' } })).map(toSystemAdminRow);
  }

  async createSystemAdminToken(input: {
    systemAdminId: string;
    tokenHash: string;
    expiresAt?: string | null;
  }): Promise<SystemAdminTokenRow> {
    return toSystemAdminTokenRow(await prisma.system_admin_tokens.create({
      data: {
        id: newSystemAdminTokenId(),
        system_admin_id: input.systemAdminId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    }));
  }

  async findSystemAdminTokenByHash(tokenHash: string): Promise<SystemAdminTokenRow | null> {
    const row = await prisma.system_admin_tokens.findUnique({ where: { token_hash: tokenHash } });
    return row ? toSystemAdminTokenRow(row) : null;
  }

  async revokeSystemAdminToken(id: string): Promise<void> {
    await prisma.system_admin_tokens.updateMany({ where: { id, revoked_at: null }, data: { revoked_at: new Date() } });
  }
}
