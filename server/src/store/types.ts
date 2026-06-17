import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { GoalState } from '../agent/goal.js';
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
  model_ref: string | null;
  output: string | null;
  error: string | null;
  goal_state: GoalState | null;
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

export type ShellActor = 'agent' | 'user' | 'system';
export type ShellOwner = 'agent' | 'user' | 'system';
export type ShellSessionStatus = 'opening' | 'idle' | 'busy' | 'closing' | 'closed' | 'orphaned';
export type ShellCommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed' | 'timed_out' | 'orphaned';
export type ShellCommandWaitMode = 'foreground' | 'background';
export type ShellLogStream = 'stdout' | 'stderr' | 'system';

export interface ShellSessionRow {
  id: string;
  thread_id: string;
  name: string;
  owner: ShellOwner;
  workspace_root: string;
  cwd: string;
  backend: string;
  status: ShellSessionStatus;
  lease_actor: ShellActor | null;
  lease_run_id: string | null;
  config_snapshot: Record<string, unknown> | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShellCommandRow {
  id: string;
  session_id: string;
  run_id: string | null;
  step_id: string | null;
  actor: ShellActor;
  command: string;
  cwd: string;
  wait_mode: ShellCommandWaitMode;
  status: ShellCommandStatus;
  attention: string | null;
  host_pid: number | null;
  child_pid: number | null;
  exit_code: number | null;
  signal: string | null;
  soft_timeout_ms: number | null;
  hard_timeout_ms: number | null;
  soft_timeout_at: string | null;
  hard_timeout_at: string | null;
  last_output_at: string | null;
  output_bytes: string | number;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

export interface ShellCommandLogRow {
  id: number;
  command_id: string;
  seq: number;
  stream: ShellLogStream;
  chunk: string;
  created_at: string;
}

export type SubagentRunStatus = 'running' | 'done' | 'error';

export interface SubagentRunRow {
  id: string;
  parent_run_id: string;
  parent_step_id: string | null;
  workflow_id: string | null;
  stage_id: string | null;
  runtime_profile_id: string | null;
  status: SubagentRunStatus;
  task_assignment: Record<string, unknown>;
  skill_names: string[];
  output: string | null;
  error: string | null;
  usage: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** A thread message as stored, carrying its DB id so the executor can mark it
 *  collapsed during compaction. `content` is the LLM-facing view (already the
 *  placeholder for masked rows); the original is preserved in the DB. */
export interface ThreadMessage extends LlmMessage {
  id: number;
}

export interface ThreadSearchResultRow {
  thread_id: string;
  thread_title: string | null;
  run_id: string;
  message_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

/**
 * Persistence port. The executor depends on this interface, not on PG directly,
 * so it can be unit-tested with an in-memory implementation.
 */
export interface Store {
  createThread(title?: string): Promise<ThreadRow>;
  getThread(id: string): Promise<ThreadRow | null>;
  listThreads(limit?: number): Promise<ThreadRow[]>;
  deleteThread(id: string): Promise<boolean>;
  searchThreadMessages(query: string, limit?: number): Promise<ThreadSearchResultRow[]>;

  createRun(threadId: string, input: string, options?: { modelRef?: string | null }): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | null>;
  listRuns(threadId: string): Promise<RunRow[]>;
  listRunsByStatus(statuses: RunStatus[]): Promise<RunRow[]>;
  setRunStatus(id: string, status: RunStatus, fields?: { output?: string; error?: string }): Promise<void>;
  /** Persist the run's goal anchor (so it's inspectable and survives a restart). */
  setGoalState(runId: string, goal: GoalState): Promise<void>;

  createStep(runId: string, idx: number): Promise<StepRow>;
  getLastStepIndex(runId: string): Promise<number>;

  /** Conversation history for a thread, in order, as the compacted LLM-facing view:
   *  masked tool results return their placeholder, 'summarized' rows are omitted. */
  loadThreadMessages(threadId: string): Promise<ThreadMessage[]>;
  countRunMessages(runId: string): Promise<number>;
  /** Append a message; returns its DB id so compaction can reference it later. */
  addMessage(threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number>;
  /** Append an L3 summary message and remember which original rows it replaces. */
  addSummaryMessage(
    threadId: string,
    runId: string,
    stepId: string | null,
    msg: LlmMessage,
    summaryOf: number[],
  ): Promise<number>;
  /** Durably mark messages collapsed (context compaction). Originals are retained. */
  markMessagesCollapsed(ids: number[], kind: 'masked' | 'summarized'): Promise<void>;

  addEvent(runId: string, stepId: string | null, event: AgentEvent): Promise<void>;
  getEvents(runId: string): Promise<AgentEvent[]>;

  createSubagentRun(input: {
    parentRunId: string;
    parentStepId?: string | null;
    workflowId?: string | null;
    stageId?: string | null;
    runtimeProfileId?: string | null;
    taskAssignment: Record<string, unknown>;
    skillNames?: string[];
  }): Promise<SubagentRunRow>;
  finishSubagentRun(
    id: string,
    fields: { status: 'done' | 'error'; output?: string | null; error?: string | null; usage?: Record<string, unknown> | null },
  ): Promise<void>;
  getSubagentRun(id: string): Promise<SubagentRunRow | null>;
  listSubagentRunsByThread(threadId: string): Promise<SubagentRunRow[]>;

  createShellSession(input: {
    threadId: string;
    name: string;
    owner: ShellOwner;
    workspaceRoot: string;
    cwd?: string;
    backend: string;
    configSnapshot?: Record<string, unknown> | null;
  }): Promise<ShellSessionRow>;
  getShellSession(id: string): Promise<ShellSessionRow | null>;
  listShellSessions(threadId: string, workspaceRoot?: string): Promise<ShellSessionRow[]>;
  updateShellSession(
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void>;

  createShellCommand(input: {
    sessionId: string;
    runId?: string | null;
    stepId?: string | null;
    actor: ShellActor;
    command: string;
    cwd: string;
    waitMode: ShellCommandWaitMode;
    softTimeoutMs?: number | null;
    hardTimeoutMs?: number | null;
    softTimeoutAt?: string | null;
    hardTimeoutAt?: string | null;
  }): Promise<ShellCommandRow>;
  getShellCommand(id: string): Promise<ShellCommandRow | null>;
  listShellCommandsBySession(sessionId: string, limit?: number): Promise<ShellCommandRow[]>;
  listRunningShellCommandsByRun(runId: string): Promise<ShellCommandRow[]>;
  listRunningShellCommands(): Promise<ShellCommandRow[]>;
  updateShellCommand(
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
  ): Promise<void>;
  appendShellCommandLog(commandId: string, stream: ShellLogStream, chunk: string): Promise<ShellCommandLogRow>;
  getShellCommandLogs(commandId: string, sinceSeq?: number, limit?: number): Promise<ShellCommandLogRow[]>;
  addShellSessionEvent(sessionId: string, actor: ShellActor, kind: string, data: unknown): Promise<void>;
}
