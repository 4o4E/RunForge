import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder } from '../agent/compaction.js';
import type { RunRow, Store, StepRow, ThreadMessage, ThreadRow } from './types.js';

export class PgStore implements Store {
  async createThread(title?: string): Promise<ThreadRow> {
    const id = randomUUID();
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

  async createRun(threadId: string, input: string): Promise<RunRow> {
    const id = randomUUID();
    const { rows } = await query<RunRow>(
      `INSERT INTO runs (id, thread_id, status, input) VALUES ($1, $2, 'pending', $3) RETURNING *`,
      [id, threadId, input],
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

  async setRunStatus(id: string, status: RunStatus, fields: { output?: string; error?: string } = {}): Promise<void> {
    await query(
      `UPDATE runs SET status = $2, output = COALESCE($3, output), error = COALESCE($4, error), updated_at = now() WHERE id = $1`,
      [id, status, fields.output ?? null, fields.error ?? null],
    );
  }

  async createStep(runId: string, idx: number): Promise<StepRow> {
    const id = randomUUID();
    const { rows } = await query<StepRow>(
      `INSERT INTO steps (id, run_id, idx) VALUES ($1, $2, $3) RETURNING *`,
      [id, runId, idx],
    );
    return rows[0];
  }

  async loadThreadMessages(threadId: string): Promise<ThreadMessage[]> {
    const { rows } = await query<{
      id: string;
      role: LlmMessage['role'];
      content: string | null;
      tool_calls: LlmMessage['toolCalls'] | null;
      tool_call_id: string | null;
      collapsed: 'masked' | 'summarized' | null;
    }>(
      `SELECT id, role, content, tool_calls, tool_call_id, collapsed FROM messages WHERE thread_id = $1 ORDER BY id`,
      [threadId],
    );
    // Build the compacted LLM-facing view. The original content stays in the DB;
    // masked rows render their placeholder, 'summarized' rows are folded out.
    return rows
      .filter((r) => r.collapsed !== 'summarized')
      .map((r) => ({
        id: Number(r.id),
        role: r.role,
        content: r.collapsed === 'masked' ? maskPlaceholder((r.content ?? '').length) : r.content,
        toolCalls: r.tool_calls ?? undefined,
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
}
