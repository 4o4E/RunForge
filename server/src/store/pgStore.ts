import { pool, query } from '../db/pool.js';
import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder, maskToolCallArguments } from '../agent/compaction.js';
import type { GoalState } from '../agent/goal.js';
import { sanitizeThreadMessagesForModel } from './messageView.js';
import type {
  AuthTokenRow,
  PushSubscriptionRow,
  RunRow,
  Scope,
  ShellActor,
  ShellCommandLogRow,
  ShellCommandRow,
  ShellLogStream,
  ShellSessionRow,
  Store,
  SubagentRunRow,
  StepRow,
  SystemAdminRow,
  TenantRow,
  ThreadNoticeRow,
  ThreadMessage,
  ThreadSearchResultRow,
  ThreadRow,
  UserRow,
} from './types.js';
import type { TenantUserRole, WebPushSubscriptionInput } from '@runforge/contracts';
import {
  newAuthTokenId,
  newRunId,
  newShellCommandId,
  newShellSessionId,
  newStepId,
  newSubagentRunId,
  newSystemAdminId,
  newThreadId,
  newUserId,
} from '../id.js';

function isEphemeralSystemMessage(role: LlmMessage['role'], content: string | null): boolean {
  return role === 'system' && typeof content === 'string' && content.startsWith('已激活 Skill / Activated Skill:');
}

export class PgStore implements Store {
  // 多租户改造 Phase 2(docs/multi-tenancy-design.md §5)。这两个私有帮助方法只给
  // 结构复杂、不方便直接把 scope 塞进查询本身的方法用(递归 CTE、多步聚合)——
  // 先校验归属,查不到就让调用方按"空结果"处理,再跑原来没改动过的查询逻辑,
  // 降低在复杂 SQL 里手改引入 bug 的风险。其余简单查询直接把 scope 折进 WHERE/JOIN。
  private async threadBelongsToScope(scope: Scope, threadId: string): Promise<boolean> {
    const { rows } = await query(
      `SELECT 1 FROM threads WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [threadId, scope.tenantId, scope.userId],
    );
    return rows.length > 0;
  }

  private async runBelongsToScope(scope: Scope, runId: string): Promise<boolean> {
    const { rows } = await query(
      `SELECT 1 FROM runs r JOIN threads t ON t.id = r.thread_id WHERE r.id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [runId, scope.tenantId, scope.userId],
    );
    return rows.length > 0;
  }

  async createThread(scope: Scope, title?: string): Promise<ThreadRow> {
    const id = newThreadId();
    const { rows } = await query<ThreadRow>(
      `INSERT INTO threads (id, tenant_id, user_id, title) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, scope.tenantId, scope.userId, title ?? null],
    );
    return rows[0];
  }

  async getThread(scope: Scope, id: string): Promise<ThreadRow | null> {
    const { rows } = await query<ThreadRow>(
      `SELECT t.*, fallback.input AS fallback_title
       FROM threads t
       LEFT JOIN LATERAL (
         SELECT input
         FROM runs
         WHERE thread_id = t.id
         ORDER BY created_at, id
         LIMIT 1
       ) fallback ON true
       WHERE t.id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [id, scope.tenantId, scope.userId],
    );
    return rows[0] ?? null;
  }

  async listThreads(scope: Scope, limit = 50, options: { archived?: boolean } = {}): Promise<ThreadRow[]> {
    const { rows } = await query<ThreadRow>(
      `SELECT t.*, fallback.input AS fallback_title
       FROM threads t
       LEFT JOIN LATERAL (
         SELECT input
         FROM runs
         WHERE thread_id = t.id
         ORDER BY created_at, id
         LIMIT 1
       ) fallback ON true
       WHERE t.tenant_id = $2 AND t.user_id = $3
         AND (($4::boolean AND t.archived_at IS NOT NULL) OR (NOT $4::boolean AND t.archived_at IS NULL))
       ORDER BY t.pinned_at DESC NULLS LAST, t.updated_at DESC, t.created_at DESC
       LIMIT $1`,
      [limit, scope.tenantId, scope.userId, options.archived === true],
    );
    return rows;
  }

  async updateThread(
    scope: Scope,
    id: string,
    fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null },
  ): Promise<ThreadRow | null> {
    let activeRunId = fields.activeRunId ?? null;
    if (fields.activeRunId) {
      // 这个 CTE 只在给定 thread_id 下找叶子 run,不需要单独加 scope——归属校验
      // 由下面主 UPDATE 的 WHERE tenant_id/user_id 兜底,查不到就返回 null。
      const { rows: runRows } = await query<{ id: string }>(
        `WITH RECURSIVE subtree AS (
           SELECT id, parent_run_id, created_at
           FROM runs
           WHERE id = $1 AND thread_id = $2

           UNION ALL

           SELECT child.id, child.parent_run_id, child.created_at
           FROM runs child
           JOIN subtree parent ON child.parent_run_id = parent.id
           WHERE child.thread_id = $2
         ),
         leaf_runs AS (
           SELECT run.id, run.created_at
           FROM subtree run
           WHERE NOT EXISTS (
             SELECT 1 FROM subtree child WHERE child.parent_run_id = run.id
           )
         )
         SELECT id FROM leaf_runs ORDER BY created_at DESC, id DESC LIMIT 1`,
        [fields.activeRunId, id],
      );
      if (!runRows.length) return null;
      activeRunId = runRows[0].id;
    }
    const { rows } = await query<ThreadRow>(
      `UPDATE threads
       SET title = CASE WHEN $2 THEN $3 ELSE title END,
           pinned_at = CASE WHEN $4::boolean IS NULL THEN pinned_at WHEN $4 THEN COALESCE(pinned_at, now()) ELSE NULL END,
           archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END,
           active_run_id = CASE WHEN $6 THEN $7 ELSE active_run_id END,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $8 AND user_id = $9
       RETURNING *`,
      [
        id,
        Object.prototype.hasOwnProperty.call(fields, 'title'),
        fields.title ?? null,
        fields.pinned ?? null,
        fields.archived ?? null,
        Object.prototype.hasOwnProperty.call(fields, 'activeRunId'),
        activeRunId,
        scope.tenantId,
        scope.userId,
      ],
    );
    return rows[0] ?? null;
  }

  async setThreadTitleIfEmpty(scope: Scope, id: string, title: string): Promise<ThreadRow | null> {
    const { rows } = await query<ThreadRow>(
      `UPDATE threads
       SET title = $2, updated_at = now()
       WHERE id = $1 AND tenant_id = $3 AND user_id = $4 AND (title IS NULL OR btrim(title) = '')
       RETURNING *`,
      [id, title, scope.tenantId, scope.userId],
    );
    return rows[0] ?? null;
  }

  async deleteThread(scope: Scope, id: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM threads WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, scope.tenantId, scope.userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async searchThreadMessages(scope: Scope, searchText: string, limit = 50): Promise<ThreadSearchResultRow[]> {
    const q = searchText.trim();
    if (!q) return [];
    const { rows } = await query<{
      thread_id: string;
      thread_title: string | null;
      run_id: string;
      message_id: string;
      role: 'user' | 'assistant';
      content: string;
      created_at: string;
    }>(
      `SELECT
         m.thread_id,
         t.title AS thread_title,
         m.run_id,
         m.id::text AS message_id,
         m.role,
         m.content,
         m.created_at
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE t.tenant_id = $3 AND t.user_id = $4
        AND m.content IS NOT NULL
        AND m.role IN ('user', 'assistant')
        AND m.content ILIKE '%' || $1 || '%'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
      [q, Math.min(Math.max(limit, 1), 100), scope.tenantId, scope.userId],
    );
    return rows.map((row) => ({ ...row, message_id: Number(row.message_id) }));
  }

  async listThreadNotices(scope: Scope, threadId: string): Promise<ThreadNoticeRow[]> {
    const { rows } = await query<ThreadNoticeRow>(
      `SELECT tn.* FROM thread_notices tn
       JOIN threads t ON t.id = tn.thread_id
       WHERE tn.thread_id = $1 AND t.tenant_id = $2 AND t.user_id = $3
       ORDER BY tn.created_at, tn.id`,
      [threadId, scope.tenantId, scope.userId],
    );
    return rows;
  }

  async addThreadNotice(scope: Scope, input: {
    threadId: string;
    kind?: string;
    message: string;
    title?: string | null;
    linkedThreadId?: string | null;
    linkedRunId?: string | null;
  }): Promise<ThreadNoticeRow> {
    const { rows } = await query<ThreadNoticeRow>(
      `INSERT INTO thread_notices (thread_id, kind, message, title, linked_thread_id, linked_run_id)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE EXISTS (SELECT 1 FROM threads WHERE id = $1 AND tenant_id = $7 AND user_id = $8)
       RETURNING *`,
      [input.threadId, input.kind ?? 'info', input.message, input.title ?? null, input.linkedThreadId ?? null, input.linkedRunId ?? null, scope.tenantId, scope.userId],
    );
    if (!rows[0]) throw new Error('threadId 不存在或不属于当前用户');
    return rows[0];
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
        `INSERT INTO threads (id, tenant_id, user_id, title) VALUES ($1, $2, $3, $4) RETURNING *`,
        [forkThreadId, scope.tenantId, scope.userId, forkTitle],
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
        const { rows: runRows } = await client.query<RunRow>(
          `INSERT INTO runs (
             id, thread_id, parent_run_id, status, input, model_ref, output, error, goal_state, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
           RETURNING *`,
          [
            newRunIdValue,
            forkThreadId,
            parentRunId,
            isSourceRun ? 'done' : oldRun.status,
            oldRun.input,
            oldRun.model_ref,
            isSourceRun ? null : oldRun.output,
            isSourceRun ? null : oldRun.error,
            oldRun.goal_state ? JSON.stringify(oldRun.goal_state) : null,
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
               thread_id, run_id, step_id, role, content, tool_calls, tool_call_id, collapsed, summary_of, created_at
             )
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::bigint[], $10)
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

  async createRun(scope: Scope, threadId: string, input: string, options: { modelRef?: string | null; parentRunId?: string | null } = {}): Promise<RunRow> {
    const { rows: threadRows } = await query<{ active_run_id: string | null }>(
      `SELECT active_run_id FROM threads WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [threadId, scope.tenantId, scope.userId],
    );
    if (!threadRows.length) throw new Error('threadId 不存在或不属于当前用户');
    const id = newRunId();
    let parentRunId = options.parentRunId;
    if (parentRunId === undefined) {
      parentRunId = threadRows[0]?.active_run_id ?? null;
      if (!parentRunId) {
        const legacy = await query<{ id: string }>(
          `SELECT id FROM runs WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [threadId],
        );
        parentRunId = legacy.rows[0]?.id ?? null;
      }
    }
    if (parentRunId) {
      const { rows } = await query<{ id: string }>(`SELECT id FROM runs WHERE id = $1 AND thread_id = $2`, [parentRunId, threadId]);
      if (!rows.length) throw new Error('parentRunId 不属于当前 thread');
    }
    const { rows } = await query<RunRow>(
      `INSERT INTO runs (id, thread_id, parent_run_id, status, input, model_ref)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING *`,
      [id, threadId, parentRunId ?? null, input, options.modelRef ?? null],
    );
    await query(`UPDATE threads SET active_run_id = $2, updated_at = now() WHERE id = $1`, [threadId, id]);
    return rows[0];
  }

  async getRun(scope: Scope, id: string): Promise<RunRow | null> {
    const { rows } = await query<RunRow>(
      `SELECT r.* FROM runs r JOIN threads t ON t.id = r.thread_id
       WHERE r.id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [id, scope.tenantId, scope.userId],
    );
    return rows[0] ?? null;
  }

  async listRuns(scope: Scope, threadId: string): Promise<RunRow[]> {
    const { rows } = await query<RunRow>(
      `SELECT r.* FROM runs r JOIN threads t ON t.id = r.thread_id
       WHERE r.thread_id = $1 AND t.tenant_id = $2 AND t.user_id = $3
       ORDER BY r.created_at`,
      [threadId, scope.tenantId, scope.userId],
    );
    return rows;
  }

  async listRunsByStatusUnscoped(statuses: RunStatus[]): Promise<RunRow[]> {
    if (!statuses.length) return [];
    const { rows } = await query<RunRow>(
      `SELECT * FROM runs WHERE status = ANY($1::text[]) ORDER BY updated_at, created_at`,
      [statuses],
    );
    return rows;
  }

  async setRunStatus(scope: Scope, id: string, status: RunStatus, fields: { output?: string | null; error?: string | null } = {}): Promise<void> {
    await query(
      `UPDATE runs
       SET status = $2,
           output = CASE WHEN $3 THEN $4 ELSE output END,
           error = CASE WHEN $5 THEN $6 ELSE error END,
           updated_at = now()
       WHERE id = $1 AND thread_id IN (SELECT id FROM threads WHERE tenant_id = $7 AND user_id = $8)`,
      [
        id,
        status,
        Object.prototype.hasOwnProperty.call(fields, 'output'),
        fields.output ?? null,
        Object.prototype.hasOwnProperty.call(fields, 'error'),
        fields.error ?? null,
        scope.tenantId,
        scope.userId,
      ],
    );
  }

  async setGoalState(scope: Scope, runId: string, goal: GoalState): Promise<void> {
    await query(
      `UPDATE runs SET goal_state = $2, updated_at = now()
       WHERE id = $1 AND thread_id IN (SELECT id FROM threads WHERE tenant_id = $3 AND user_id = $4)`,
      [runId, JSON.stringify(goal), scope.tenantId, scope.userId],
    );
  }

  async getRunUnscoped(id: string): Promise<RunRow | null> {
    const { rows } = await query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async getThreadUnscoped(id: string): Promise<ThreadRow | null> {
    const { rows } = await query<ThreadRow>(`SELECT * FROM threads WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async createStep(scope: Scope, runId: string, idx: number): Promise<StepRow> {
    const id = newStepId();
    const { rows } = await query<StepRow>(
      `INSERT INTO steps (id, run_id, idx)
       SELECT $1, $2, $3
       WHERE EXISTS (SELECT 1 FROM runs r JOIN threads t ON t.id = r.thread_id WHERE r.id = $2 AND t.tenant_id = $4 AND t.user_id = $5)
       RETURNING *`,
      [id, runId, idx, scope.tenantId, scope.userId],
    );
    if (!rows.length) throw new Error('runId 不存在或不属于当前用户');
    return rows[0];
  }

  async getLastStepIndex(scope: Scope, runId: string): Promise<number> {
    const { rows } = await query<{ idx: number | null }>(
      `SELECT max(s.idx) AS idx FROM steps s
       JOIN runs r ON r.id = s.run_id JOIN threads t ON t.id = r.thread_id
       WHERE s.run_id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [runId, scope.tenantId, scope.userId],
    );
    return rows[0]?.idx ?? 0;
  }

  async getLastCompletedStepIndex(scope: Scope, runId: string): Promise<number> {
    const owns = await this.runBelongsToScope(scope, runId);
    if (!owns) return 0;
    const { rows } = await query<{
      step_id: string;
      idx: number;
      role: LlmMessage['role'] | null;
      tool_calls: LlmMessage['toolCalls'] | null;
      tool_call_id: string | null;
    }>(
      `SELECT s.id AS step_id, s.idx, m.role, m.tool_calls, m.tool_call_id
       FROM steps s
       LEFT JOIN messages m ON m.step_id = s.id
       WHERE s.run_id = $1
       ORDER BY s.idx, m.id`,
      [runId],
    );
    const byStep = new Map<string, typeof rows>();
    const stepIndex = new Map<string, number>();
    for (const row of rows) {
      byStep.set(row.step_id, [...(byStep.get(row.step_id) ?? []), row]);
      stepIndex.set(row.step_id, row.idx);
    }
    let last = 0;
    for (const [stepId, stepRows] of byStep) {
      const assistantRows = stepRows.filter((row) => row.role === 'assistant');
      if (!assistantRows.length) continue;
      const requiredToolIds = assistantRows.flatMap((row) => (row.tool_calls ?? []).map((call) => call.id));
      const answeredToolIds = new Set(stepRows.filter((row) => row.role === 'tool' && row.tool_call_id).map((row) => row.tool_call_id as string));
      if (requiredToolIds.every((id) => answeredToolIds.has(id))) last = Math.max(last, stepIndex.get(stepId) ?? 0);
    }
    return last;
  }

  async loadThreadMessages(scope: Scope, threadId: string, options: { runId?: string | null } = {}): Promise<ThreadMessage[]> {
    const owns = await this.threadBelongsToScope(scope, threadId);
    if (!owns) return [];
    const targetRunId = options.runId ?? null;
    const { rows } = await query<{
      id: string;
      role: LlmMessage['role'];
      content: string | null;
      tool_calls: LlmMessage['toolCalls'] | null;
      tool_call_id: string | null;
      collapsed: 'masked' | 'summarized' | null;
      summary_of: string[] | null;
    }>(
      `WITH RECURSIVE selected_run AS (
         SELECT COALESCE($2::text, active_run_id) AS id
         FROM threads
         WHERE id = $1
       ),
       branch_runs AS (
         SELECT r.id, r.parent_run_id, 1 AS depth
         FROM runs r
         JOIN selected_run s ON s.id = r.id
         WHERE r.thread_id = $1

         UNION ALL

         SELECT parent.id, parent.parent_run_id, child.depth + 1
         FROM runs parent
         JOIN branch_runs child ON child.parent_run_id = parent.id
         WHERE parent.thread_id = $1
       ),
       fallback_runs AS (
         SELECT id, NULL::text AS parent_run_id, 0 AS depth
         FROM runs
         WHERE thread_id = $1
           AND NOT EXISTS (SELECT 1 FROM selected_run WHERE id IS NOT NULL)
       ),
       visible_runs AS (
         SELECT id FROM branch_runs
         UNION
         SELECT id FROM fallback_runs
       )
       SELECT m.id, m.role, m.content, m.tool_calls, m.tool_call_id, m.collapsed, m.summary_of
       FROM messages m
       JOIN visible_runs vr ON vr.id = m.run_id
       WHERE m.thread_id = $1
       ORDER BY m.id`,
      [threadId, targetRunId],
    );
    // Build the compacted LLM-facing view. The original content/tool args stay in
    // the DB; masked rows render placeholders, summarized rows are folded out.
    const messages = rows
      .filter((r) => r.collapsed !== 'summarized' && !isEphemeralSystemMessage(r.role, r.content))
      .sort((a, b) => Number(a.summary_of?.[0] ?? a.id) - Number(b.summary_of?.[0] ?? b.id))
      .map((r) => ({
        id: Number(r.id),
        role: r.role,
        content: r.collapsed === 'masked' && r.role === 'tool' ? maskPlaceholder(r.content ?? '') : r.content,
        toolCalls:
          r.collapsed === 'masked' && r.role === 'assistant' && r.tool_calls
            ? maskToolCallArguments(r.tool_calls).calls
            : (r.tool_calls ?? undefined),
        toolCallId: r.tool_call_id ?? undefined,
        collapsed: r.collapsed ?? undefined,
      }));
    return sanitizeThreadMessagesForModel(messages);
  }

  async addMessage(scope: Scope, threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO messages (thread_id, run_id, step_id, role, content, tool_calls, tool_call_id)
       SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE EXISTS (SELECT 1 FROM threads WHERE id = $1 AND tenant_id = $8 AND user_id = $9)
       RETURNING id`,
      [
        threadId,
        runId,
        stepId,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        scope.tenantId,
        scope.userId,
      ],
    );
    if (!rows.length) throw new Error('threadId 不存在或不属于当前用户');
    return Number(rows[0].id);
  }

  async countRunMessages(scope: Scope, runId: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.run_id = $1 AND t.tenant_id = $2 AND t.user_id = $3`,
      [runId, scope.tenantId, scope.userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async addSummaryMessage(
    scope: Scope,
    threadId: string,
    runId: string,
    stepId: string | null,
    msg: LlmMessage,
    summaryOf: number[],
  ): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO messages (thread_id, run_id, step_id, role, content, tool_calls, tool_call_id, summary_of)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::bigint[]
       WHERE EXISTS (SELECT 1 FROM threads WHERE id = $1 AND tenant_id = $9 AND user_id = $10)
       RETURNING id`,
      [
        threadId,
        runId,
        stepId,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        summaryOf,
        scope.tenantId,
        scope.userId,
      ],
    );
    if (!rows.length) throw new Error('threadId 不存在或不属于当前用户');
    return Number(rows[0].id);
  }

  async markMessagesCollapsed(scope: Scope, ids: number[], kind: 'masked' | 'summarized'): Promise<void> {
    if (!ids.length) return;
    await query(
      `UPDATE messages SET collapsed = $2
       WHERE id = ANY($1::bigint[]) AND thread_id IN (SELECT id FROM threads WHERE tenant_id = $3 AND user_id = $4)`,
      [ids, kind, scope.tenantId, scope.userId],
    );
  }

  async addEvent(scope: Scope, runId: string, stepId: string | null, event: AgentEvent): Promise<void> {
    const idx = 'step' in event ? event.step : 0;
    await query(
      `INSERT INTO events (run_id, step_id, idx, type, data)
       SELECT $1, $2, $3, $4, $5
       WHERE EXISTS (
         SELECT 1 FROM runs r JOIN threads t ON t.id = r.thread_id
         WHERE r.id = $1 AND t.tenant_id = $6 AND t.user_id = $7
       )`,
      [runId, stepId, idx, event.type, JSON.stringify(event), scope.tenantId, scope.userId],
    );
  }

  async getEvents(scope: Scope, runId: string): Promise<AgentEvent[]> {
    const { rows } = await query<{ data: AgentEvent }>(
      `SELECT e.data FROM events e
       JOIN runs r ON r.id = e.run_id JOIN threads t ON t.id = r.thread_id
       WHERE e.run_id = $1 AND t.tenant_id = $2 AND t.user_id = $3
       ORDER BY e.id`,
      [runId, scope.tenantId, scope.userId],
    );
    return rows.map((r) => r.data);
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

  // 多租户改造 Phase 1(docs/multi-tenancy-design.md §4)。
  async createTenant(input: { id: string; name: string }): Promise<TenantRow> {
    const { rows } = await query<TenantRow>(
      `INSERT INTO tenants (id, name) VALUES ($1, $2) RETURNING *`,
      [input.id, input.name],
    );
    return rows[0];
  }

  async findTenant(id: string): Promise<TenantRow | null> {
    const { rows } = await query<TenantRow>(`SELECT * FROM tenants WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listTenants(): Promise<TenantRow[]> {
    const { rows } = await query<TenantRow>(`SELECT * FROM tenants ORDER BY created_at`);
    return rows;
  }

  async createUser(input: { tenantId: string; email: string; passwordHash: string; role: TenantUserRole }): Promise<UserRow> {
    const { rows } = await query<UserRow>(
      `INSERT INTO users (id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [newUserId(), input.tenantId, input.email, input.passwordHash, input.role],
    );
    return rows[0];
  }

  async findUserByEmail(tenantId: string, email: string): Promise<UserRow | null> {
    const { rows } = await query<UserRow>(
      `SELECT * FROM users WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email],
    );
    return rows[0] ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const { rows } = await query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listUsersByTenant(tenantId: string): Promise<UserRow[]> {
    const { rows } = await query<UserRow>(
      `SELECT * FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows;
  }

  async updateUserRole(id: string, role: TenantUserRole): Promise<UserRow | null> {
    const { rows } = await query<UserRow>(
      `UPDATE users SET role = $2 WHERE id = $1 RETURNING *`,
      [id, role],
    );
    return rows[0] ?? null;
  }

  async updateUserStatus(id: string, status: 'active' | 'disabled'): Promise<UserRow | null> {
    const { rows } = await query<UserRow>(
      `UPDATE users SET status = $2 WHERE id = $1 RETURNING *`,
      [id, status],
    );
    return rows[0] ?? null;
  }

  async createAuthToken(input: {
    tenantId: string;
    userId: string;
    kind: 'refresh' | 'api';
    tokenHash: string;
    label?: string | null;
    expiresAt?: string | null;
  }): Promise<AuthTokenRow> {
    const { rows } = await query<AuthTokenRow>(
      `INSERT INTO auth_tokens (id, tenant_id, user_id, kind, token_hash, label, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [newAuthTokenId(), input.tenantId, input.userId, input.kind, input.tokenHash, input.label ?? null, input.expiresAt ?? null],
    );
    return rows[0];
  }

  async findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRow | null> {
    const { rows } = await query<AuthTokenRow>(
      `SELECT * FROM auth_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async revokeAuthToken(id: string): Promise<void> {
    await query(
      `UPDATE auth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }

  async listApiTokensByTenant(tenantId: string): Promise<AuthTokenRow[]> {
    const { rows } = await query<AuthTokenRow>(
      `SELECT * FROM auth_tokens WHERE tenant_id = $1 AND kind = 'api' ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows;
  }

  async createSystemAdmin(input: { email: string; passwordHash: string }): Promise<SystemAdminRow> {
    const { rows } = await query<SystemAdminRow>(
      `INSERT INTO system_admins (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
      [newSystemAdminId(), input.email, input.passwordHash],
    );
    return rows[0];
  }

  async findSystemAdminByEmail(email: string): Promise<SystemAdminRow | null> {
    const { rows } = await query<SystemAdminRow>(`SELECT * FROM system_admins WHERE email = $1`, [email]);
    return rows[0] ?? null;
  }

  async listSystemAdmins(): Promise<SystemAdminRow[]> {
    const { rows } = await query<SystemAdminRow>(`SELECT * FROM system_admins ORDER BY created_at`);
    return rows;
  }
}
