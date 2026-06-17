import { query } from '../db/pool.js';
import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder, maskToolCallArguments } from '../agent/compaction.js';
import type { GoalState } from '../agent/goal.js';
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
    const { rows } = await query<ThreadRow>(`SELECT * FROM threads WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listThreads(limit = 50): Promise<ThreadRow[]> {
    const { rows } = await query<ThreadRow>(
      `SELECT * FROM threads ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
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

  async createRun(threadId: string, input: string, options: { modelRef?: string | null } = {}): Promise<RunRow> {
    const id = newRunId();
    const { rows } = await query<RunRow>(
      `INSERT INTO runs (id, thread_id, status, input, model_ref) VALUES ($1, $2, 'pending', $3, $4) RETURNING *`,
      [id, threadId, input, options.modelRef ?? null],
    );
    await query(`UPDATE threads SET updated_at = now() WHERE id = $1`, [threadId]);
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

  async loadThreadMessages(threadId: string): Promise<ThreadMessage[]> {
    const { rows } = await query<{
      id: string;
      role: LlmMessage['role'];
      content: string | null;
      tool_calls: LlmMessage['toolCalls'] | null;
      tool_call_id: string | null;
      collapsed: 'masked' | 'summarized' | null;
      summary_of: string[] | null;
    }>(
      `SELECT id, role, content, tool_calls, tool_call_id, collapsed, summary_of FROM messages WHERE thread_id = $1 ORDER BY id`,
      [threadId],
    );
    // Build the compacted LLM-facing view. The original content/tool args stay in
    // the DB; masked rows render placeholders, summarized rows are folded out.
    return rows
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
