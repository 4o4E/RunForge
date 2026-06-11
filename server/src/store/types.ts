import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';

export interface ThreadRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  thread_id: string;
  status: RunStatus;
  input: string;
  output: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StepRow {
  id: string;
  run_id: string;
  idx: number;
  created_at: string;
}

export interface StoredEvent {
  step_id: string | null;
  idx: number;
  event: AgentEvent;
}

/** A thread message as stored, carrying its DB id so the executor can mark it
 *  collapsed during compaction. `content` is the LLM-facing view (already the
 *  placeholder for masked rows); the original is preserved in the DB. */
export interface ThreadMessage extends LlmMessage {
  id: number;
}

/**
 * Persistence port. The executor depends on this interface, not on PG directly,
 * so it can be unit-tested with an in-memory implementation.
 */
export interface Store {
  createThread(title?: string): Promise<ThreadRow>;
  getThread(id: string): Promise<ThreadRow | null>;
  listThreads(limit?: number): Promise<ThreadRow[]>;

  createRun(threadId: string, input: string): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | null>;
  listRuns(threadId: string): Promise<RunRow[]>;
  setRunStatus(id: string, status: RunStatus, fields?: { output?: string; error?: string }): Promise<void>;

  createStep(runId: string, idx: number): Promise<StepRow>;

  /** Conversation history for a thread, in order, as the compacted LLM-facing view:
   *  masked tool results return their placeholder, 'summarized' rows are omitted. */
  loadThreadMessages(threadId: string): Promise<ThreadMessage[]>;
  /** Append a message; returns its DB id so compaction can reference it later. */
  addMessage(threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number>;
  /** Durably mark messages collapsed (context compaction). Originals are retained. */
  markMessagesCollapsed(ids: number[], kind: 'masked' | 'summarized'): Promise<void>;

  addEvent(runId: string, stepId: string | null, event: AgentEvent): Promise<void>;
  getEvents(runId: string): Promise<AgentEvent[]>;
}
