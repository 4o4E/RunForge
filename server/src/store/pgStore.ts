import { pool, query } from '../db/pool.js';
import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder, maskToolCallArguments } from '../agent/compaction.js';
import type { GoalState } from '../agent/goal.js';
import { sanitizeThreadMessagesForModel } from './messageView.js';
import type {
  RunRow,
  ShellActor,
  ShellCommandLogRow,
  ShellCommandRow,
  ShellLogStream,
  ShellSessionRow,
  Store,
  SubagentRunRow,
  StepRow,
  ThreadNoticeRow,
  ThreadMessage,
  ThreadSearchResultRow,
  ThreadRow,
} from './types.js';
import { newRunId, newShellCommandId, newShellSessionId, newStepId, newSubagentRunId, newThreadId } from '../id.js';

function isEphemeralSystemMessage(role: LlmMessage['role'], content: string | null): boolean {
  return role === 'system' && typeof content === 'string' && content.startsWith('已激活 Skill / Activated Skill:');
}

export class PgStore implements Store {
  async createThread(title?: string): Promise<ThreadRow> {
    const id = newThreadId();
    const { rows } = await query<ThreadRow>(
      `INSERT INTO threads (id, title) VALUES ($1, $2) RETURNING *`,
      [id, title ?? null],
    );
    return rows[0];
  }

  async getThread(id: string): Promise<ThreadRow | null> {
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
       WHERE t.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listThreads(limit = 50, options: { archived?: boolean } = {}): Promise<ThreadRow[]> {
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
       WHERE (($2::boolean AND t.archived_at IS NOT NULL) OR (NOT $2::boolean AND t.archived_at IS NULL))
       ORDER BY t.pinned_at DESC NULLS LAST, t.updated_at DESC, t.created_at DESC
       LIMIT $1`,
      [limit, options.archived === true],
    );
    return rows;
  }

  async updateThread(id: string, fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null }): Promise<ThreadRow | null> {
    let activeRunId = fields.activeRunId ?? null;
    if (fields.activeRunId) {
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
       WHERE id = $1
       RETURNING *`,
      [
        id,
        Object.prototype.hasOwnProperty.call(fields, 'title'),
        fields.title ?? null,
        fields.pinned ?? null,
        fields.archived ?? null,
        Object.prototype.hasOwnProperty.call(fields, 'activeRunId'),
        activeRunId,
      ],
    );
    return rows[0] ?? null;
  }

  async setThreadTitleIfEmpty(id: string, title: string): Promise<ThreadRow | null> {
    const { rows } = await query<ThreadRow>(
      `UPDATE threads
       SET title = $2, updated_at = now()
       WHERE id = $1 AND (title IS NULL OR btrim(title) = '')
       RETURNING *`,
      [id, title],
    );
    return rows[0] ?? null;
  }

  async deleteThread(id: string): Promise<boolean> {
    const result = await query(`DELETE FROM threads WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async searchThreadMessages(searchText: string, limit = 50): Promise<ThreadSearchResultRow[]> {
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
      WHERE m.content IS NOT NULL
        AND m.role IN ('user', 'assistant')
        AND m.content ILIKE '%' || $1 || '%'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
      [q, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((row) => ({ ...row, message_id: Number(row.message_id) }));
  }

  async listThreadNotices(threadId: string): Promise<ThreadNoticeRow[]> {
    const { rows } = await query<ThreadNoticeRow>(
      `SELECT * FROM thread_notices WHERE thread_id = $1 ORDER BY created_at, id`,
      [threadId],
    );
    return rows;
  }

  async addThreadNotice(input: {
    threadId: string;
    kind?: string;
    message: string;
    title?: string | null;
    linkedThreadId?: string | null;
    linkedRunId?: string | null;
  }): Promise<ThreadNoticeRow> {
    const { rows } = await query<ThreadNoticeRow>(
      `INSERT INTO thread_notices (thread_id, kind, message, title, linked_thread_id, linked_run_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.threadId, input.kind ?? 'info', input.message, input.title ?? null, input.linkedThreadId ?? null, input.linkedRunId ?? null],
    );
    return rows[0];
  }

  async forkThreadAtRun(sourceRunId: string): Promise<{ thread: ThreadRow; activeRun: RunRow } | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: sourceRows } = await client.query<RunRow>(
        `SELECT * FROM runs WHERE id = $1`,
        [sourceRunId],
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
      const { rows: newThreadRows } = await client.query<ThreadRow>(
        `INSERT INTO threads (id, title) VALUES ($1, $2) RETURNING *`,
        [forkThreadId, forkTitle],
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
      const refreshedThread = await this.getThread(forkThreadId);
      return refreshedThread ? { thread: refreshedThread, activeRun } : { thread: newThread, activeRun };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createRun(threadId: string, input: string, options: { modelRef?: string | null; parentRunId?: string | null } = {}): Promise<RunRow> {
    const id = newRunId();
    let parentRunId = options.parentRunId;
    if (parentRunId === undefined) {
      const { rows } = await query<{ active_run_id: string | null }>(`SELECT active_run_id FROM threads WHERE id = $1`, [threadId]);
      parentRunId = rows[0]?.active_run_id ?? null;
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

  async getRun(id: string): Promise<RunRow | null> {
    const { rows } = await query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listRuns(threadId: string): Promise<RunRow[]> {
    const { rows } = await query<RunRow>(
      `SELECT * FROM runs WHERE thread_id = $1 ORDER BY created_at`,
      [threadId],
    );
    return rows;
  }

  async listRunsByStatus(statuses: RunStatus[]): Promise<RunRow[]> {
    if (!statuses.length) return [];
    const { rows } = await query<RunRow>(
      `SELECT * FROM runs WHERE status = ANY($1::text[]) ORDER BY updated_at, created_at`,
      [statuses],
    );
    return rows;
  }

  async setRunStatus(id: string, status: RunStatus, fields: { output?: string; error?: string } = {}): Promise<void> {
    await query(
      `UPDATE runs SET status = $2, output = COALESCE($3, output), error = COALESCE($4, error), updated_at = now() WHERE id = $1`,
      [id, status, fields.output ?? null, fields.error ?? null],
    );
  }

  async setGoalState(runId: string, goal: GoalState): Promise<void> {
    await query(`UPDATE runs SET goal_state = $2, updated_at = now() WHERE id = $1`, [runId, JSON.stringify(goal)]);
  }

  async createStep(runId: string, idx: number): Promise<StepRow> {
    const id = newStepId();
    const { rows } = await query<StepRow>(
      `INSERT INTO steps (id, run_id, idx) VALUES ($1, $2, $3) RETURNING *`,
      [id, runId, idx],
    );
    return rows[0];
  }

  async getLastStepIndex(runId: string): Promise<number> {
    const { rows } = await query<{ idx: number | null }>(`SELECT max(idx) AS idx FROM steps WHERE run_id = $1`, [runId]);
    return rows[0]?.idx ?? 0;
  }

  async loadThreadMessages(threadId: string, options: { runId?: string | null } = {}): Promise<ThreadMessage[]> {
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

  async addMessage(threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO messages (thread_id, run_id, step_id, role, content, tool_calls, tool_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        threadId,
        runId,
        stepId,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
      ],
    );
    return Number(rows[0].id);
  }

  async countRunMessages(runId: string): Promise<number> {
    const { rows } = await query<{ count: string }>(`SELECT count(*)::text AS count FROM messages WHERE run_id = $1`, [runId]);
    return Number(rows[0]?.count ?? 0);
  }

  async addSummaryMessage(
    threadId: string,
    runId: string,
    stepId: string | null,
    msg: LlmMessage,
    summaryOf: number[],
  ): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO messages (thread_id, run_id, step_id, role, content, tool_calls, tool_call_id, summary_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint[]) RETURNING id`,
      [
        threadId,
        runId,
        stepId,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        summaryOf,
      ],
    );
    return Number(rows[0].id);
  }

  async markMessagesCollapsed(ids: number[], kind: 'masked' | 'summarized'): Promise<void> {
    if (!ids.length) return;
    await query(`UPDATE messages SET collapsed = $2 WHERE id = ANY($1::bigint[])`, [ids, kind]);
  }

  async addEvent(runId: string, stepId: string | null, event: AgentEvent): Promise<void> {
    const idx = 'step' in event ? event.step : 0;
    await query(
      `INSERT INTO events (run_id, step_id, idx, type, data) VALUES ($1, $2, $3, $4, $5)`,
      [runId, stepId, idx, event.type, JSON.stringify(event)],
    );
  }

  async getEvents(runId: string): Promise<AgentEvent[]> {
    const { rows } = await query<{ data: AgentEvent }>(
      `SELECT data FROM events WHERE run_id = $1 ORDER BY id`,
      [runId],
    );
    return rows.map((r) => r.data);
  }

  async createSubagentRun(input: {
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
         id, parent_run_id, parent_step_id, workflow_id, stage_id, runtime_profile_id,
         status, task_assignment, skill_names
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb, $8::text[])
       RETURNING *`,
      [
        id,
        input.parentRunId,
        input.parentStepId ?? null,
        input.workflowId ?? null,
        input.stageId ?? null,
        input.runtimeProfileId ?? null,
        JSON.stringify(input.taskAssignment),
        input.skillNames ?? [],
      ],
    );
    return rows[0];
  }

  async finishSubagentRun(
    id: string,
    fields: { status: 'done' | 'error'; output?: string | null; error?: string | null; usage?: Record<string, unknown> | null },
  ): Promise<void> {
    await query(
      `UPDATE subagent_runs
       SET status = $2, output = $3, error = $4, usage = $5::jsonb, updated_at = now(), finished_at = now()
       WHERE id = $1`,
      [
        id,
        fields.status,
        fields.output ?? null,
        fields.error ?? null,
        fields.usage ? JSON.stringify(fields.usage) : null,
      ],
    );
  }

  async getSubagentRun(id: string): Promise<SubagentRunRow | null> {
    const { rows } = await query<SubagentRunRow>(`SELECT * FROM subagent_runs WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listSubagentRunsByThread(threadId: string): Promise<SubagentRunRow[]> {
    const { rows } = await query<SubagentRunRow>(
      `SELECT sr.*
       FROM subagent_runs sr
       JOIN runs r ON r.id = sr.parent_run_id
       WHERE r.thread_id = $1
       ORDER BY sr.created_at`,
      [threadId],
    );
    return rows;
  }

  async createShellSession(input: {
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
      `INSERT INTO shell_sessions (id, thread_id, name, owner, workspace_root, cwd, backend, status, config_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'idle', $8::jsonb) RETURNING *`,
      [
        id,
        input.threadId,
        input.name,
        input.owner,
        input.workspaceRoot,
        input.cwd ?? input.workspaceRoot,
        input.backend,
        input.configSnapshot ? JSON.stringify(input.configSnapshot) : null,
      ],
    );
    return rows[0];
  }

  async getShellSession(id: string): Promise<ShellSessionRow | null> {
    const { rows } = await query<ShellSessionRow>(`SELECT * FROM shell_sessions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listShellSessions(threadId: string, workspaceRoot?: string): Promise<ShellSessionRow[]> {
    const { rows } = workspaceRoot
      ? await query<ShellSessionRow>(
          `SELECT * FROM shell_sessions WHERE thread_id = $1 AND workspace_root = $2 AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC`,
          [threadId, workspaceRoot],
        )
      : await query<ShellSessionRow>(
          `SELECT * FROM shell_sessions WHERE thread_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC`,
          [threadId],
        );
    return rows;
  }

  async updateShellSession(
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

  async createShellCommand(input: {
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, $12)
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
      ],
    );
    return rows[0];
  }

  async getShellCommand(id: string): Promise<ShellCommandRow | null> {
    const { rows } = await query<ShellCommandRow>(`SELECT * FROM shell_commands WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listShellCommandsBySession(sessionId: string, limit = 20): Promise<ShellCommandRow[]> {
    const { rows } = await query<ShellCommandRow>(
      `SELECT * FROM shell_commands WHERE session_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [sessionId, limit],
    );
    return rows;
  }

  async listRunningShellCommandsByRun(runId: string): Promise<ShellCommandRow[]> {
    const { rows } = await query<ShellCommandRow>(
      `SELECT * FROM shell_commands WHERE run_id = $1 AND status = 'running' ORDER BY started_at`,
      [runId],
    );
    return rows;
  }

  async listRunningShellCommands(): Promise<ShellCommandRow[]> {
    const { rows } = await query<ShellCommandRow>(
      `SELECT * FROM shell_commands WHERE status IN ('queued', 'running') ORDER BY updated_at`,
    );
    return rows;
  }

  async updateShellCommand(
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

  async appendShellCommandLog(commandId: string, stream: ShellLogStream, chunk: string): Promise<ShellCommandLogRow> {
    const { rows } = await query<ShellCommandLogRow>(
      `WITH next_seq AS (
         SELECT COALESCE(max(seq), 0) + 1 AS seq FROM shell_command_logs WHERE command_id = $1
       )
       INSERT INTO shell_command_logs (command_id, seq, stream, chunk)
       SELECT $1, seq, $2, $3 FROM next_seq
       RETURNING *`,
      [commandId, stream, chunk],
    );
    return rows[0];
  }

  async getShellCommandLogs(commandId: string, sinceSeq = 0, limit = 200): Promise<ShellCommandLogRow[]> {
    const { rows } = await query<ShellCommandLogRow>(
      `SELECT * FROM shell_command_logs WHERE command_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [commandId, sinceSeq, limit],
    );
    return rows;
  }

  async addShellSessionEvent(sessionId: string, actor: ShellActor, kind: string, data: unknown): Promise<void> {
    await query(
      `INSERT INTO shell_session_events (session_id, actor, kind, data) VALUES ($1, $2, $3, $4)`,
      [sessionId, actor, kind, JSON.stringify(data ?? {})],
    );
  }
}
