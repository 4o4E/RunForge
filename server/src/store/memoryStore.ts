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
  ThreadRow,
} from './types.js';
import { newRunId, newShellCommandId, newShellSessionId, newStepId, newSubagentRunId, newThreadId } from '../id.js';

function isEphemeralSystemMessage(role: LlmMessage['role'], content: string | null): boolean {
  return role === 'system' && typeof content === 'string' && content.startsWith('已激活 Skill / Activated Skill:');
}

interface StoredMsg {
  thread_id: string;
  run_id: string;
  step_id: string | null;
  role: LlmMessage['role'];
  content: string | null;
  toolCalls?: LlmMessage['toolCalls'];
  toolCallId?: string;
  collapsed?: 'masked' | 'summarized';
  summaryOf?: number[];
  seq: number;
}

/** In-memory Store for unit tests and network-free local runs. */
export class MemoryStore implements Store {
  private threads = new Map<string, ThreadRow>();
  private runs = new Map<string, RunRow>();
  private steps: StepRow[] = [];
  private messages: StoredMsg[] = [];
  private events = new Map<string, AgentEvent[]>();
  private shellSessions = new Map<string, ShellSessionRow>();
  private shellCommands = new Map<string, ShellCommandRow>();
  private shellLogs = new Map<string, ShellCommandLogRow[]>();
  private subagentRuns = new Map<string, SubagentRunRow>();
  private seq = 0;
  private shellLogSeq = 0;
  private now = () => new Date().toISOString();

  async createThread(title?: string): Promise<ThreadRow> {
    const row: ThreadRow = { id: newThreadId(), title: title ?? null, created_at: this.now(), updated_at: this.now() };
    this.threads.set(row.id, row);
    return row;
  }
  async getThread(id: string) {
    return this.threads.get(id) ?? null;
  }
  async listThreads(limit = 50) {
    return [...this.threads.values()].slice(0, limit);
  }
  async deleteThread(id: string) {
    const existed = this.threads.delete(id);
    if (!existed) return false;
    const runIds = new Set([...this.runs.values()].filter((r) => r.thread_id === id).map((r) => r.id));
    for (const runId of runIds) {
      this.runs.delete(runId);
      this.events.delete(runId);
    }
    for (const [subagentRunId, row] of this.subagentRuns) {
      if (runIds.has(row.parent_run_id)) this.subagentRuns.delete(subagentRunId);
    }
    const sessionIds = new Set([...this.shellSessions.values()].filter((s) => s.thread_id === id).map((s) => s.id));
    const commandIds = new Set([...this.shellCommands.values()].filter((c) => sessionIds.has(c.session_id)).map((c) => c.id));
    for (const sessionId of sessionIds) this.shellSessions.delete(sessionId);
    for (const commandId of commandIds) {
      this.shellCommands.delete(commandId);
      this.shellLogs.delete(commandId);
    }
    this.steps = this.steps.filter((s) => !runIds.has(s.run_id));
    this.messages = this.messages.filter((m) => m.thread_id !== id);
    return true;
  }

  async createRun(threadId: string, input: string): Promise<RunRow> {
    const row: RunRow = {
      id: newRunId(),
      thread_id: threadId,
      status: 'pending',
      input,
      output: null,
      error: null,
      goal_state: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.runs.set(row.id, row);
    return row;
  }
  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  async listRuns(threadId: string) {
    return [...this.runs.values()].filter((r) => r.thread_id === threadId);
  }
  async listRunsByStatus(statuses: RunStatus[]) {
    const set = new Set(statuses);
    return [...this.runs.values()].filter((r) => set.has(r.status));
  }
  async setRunStatus(id: string, status: RunStatus, fields: { output?: string; error?: string } = {}) {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = status;
    if (fields.output !== undefined) run.output = fields.output;
    if (fields.error !== undefined) run.error = fields.error;
    run.updated_at = this.now();
  }
  async setGoalState(runId: string, goal: GoalState) {
    const run = this.runs.get(runId);
    if (run) {
      run.goal_state = goal;
      run.updated_at = this.now();
    }
  }

  async createStep(runId: string, idx: number): Promise<StepRow> {
    const row: StepRow = { id: newStepId(), run_id: runId, idx, created_at: this.now() };
    this.steps.push(row);
    return row;
  }
  async getLastStepIndex(runId: string): Promise<number> {
    return this.steps.filter((s) => s.run_id === runId).reduce((max, s) => Math.max(max, s.idx), 0);
  }

  async loadThreadMessages(threadId: string): Promise<ThreadMessage[]> {
    return this.messages
      .filter((m) => m.thread_id === threadId && m.collapsed !== 'summarized' && !isEphemeralSystemMessage(m.role, m.content))
      .sort((a, b) => (a.summaryOf?.[0] ?? a.seq) - (b.summaryOf?.[0] ?? b.seq))
      .map((m) => ({
        id: m.seq,
        role: m.role,
        content: m.collapsed === 'masked' && m.role === 'tool' ? maskPlaceholder(m.content ?? '') : m.content,
        toolCalls:
          m.collapsed === 'masked' && m.role === 'assistant' && m.toolCalls
            ? maskToolCallArguments(m.toolCalls).calls
            : m.toolCalls,
        toolCallId: m.toolCallId,
        collapsed: m.collapsed,
      }));
  }
  async countRunMessages(runId: string): Promise<number> {
    return this.messages.filter((m) => m.run_id === runId).length;
  }
  async addMessage(threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number> {
    const seq = this.seq++;
    this.messages.push({
      thread_id: threadId,
      run_id: runId,
      step_id: stepId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      seq,
    });
    return seq;
  }
  async addSummaryMessage(
    threadId: string,
    runId: string,
    stepId: string | null,
    msg: LlmMessage,
    summaryOf: number[],
  ): Promise<number> {
    const id = await this.addMessage(threadId, runId, stepId, msg);
    const row = this.messages.find((m) => m.seq === id);
    if (row) row.summaryOf = summaryOf;
    return id;
  }

  async markMessagesCollapsed(ids: number[], kind: 'masked' | 'summarized'): Promise<void> {
    const set = new Set(ids);
    for (const m of this.messages) if (set.has(m.seq)) m.collapsed = kind;
  }

  async addEvent(runId: string, _stepId: string | null, event: AgentEvent) {
    const list = this.events.get(runId) ?? [];
    list.push(event);
    this.events.set(runId, list);
  }
  async getEvents(runId: string) {
    return this.events.get(runId) ?? [];
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
    const now = this.now();
    const row: SubagentRunRow = {
      id: newSubagentRunId(),
      parent_run_id: input.parentRunId,
      parent_step_id: input.parentStepId ?? null,
      workflow_id: input.workflowId ?? null,
      stage_id: input.stageId ?? null,
      runtime_profile_id: input.runtimeProfileId ?? null,
      status: 'running',
      task_assignment: input.taskAssignment,
      skill_names: input.skillNames ?? [],
      output: null,
      error: null,
      usage: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    this.subagentRuns.set(row.id, row);
    return row;
  }

  async finishSubagentRun(
    id: string,
    fields: { status: 'done' | 'error'; output?: string | null; error?: string | null; usage?: Record<string, unknown> | null },
  ): Promise<void> {
    const row = this.subagentRuns.get(id);
    if (!row) return;
    row.status = fields.status;
    if (fields.output !== undefined) row.output = fields.output;
    if (fields.error !== undefined) row.error = fields.error;
    if (fields.usage !== undefined) row.usage = fields.usage;
    row.updated_at = this.now();
    row.finished_at = row.updated_at;
  }

  async getSubagentRun(id: string): Promise<SubagentRunRow | null> {
    return this.subagentRuns.get(id) ?? null;
  }

  async listSubagentRunsByThread(threadId: string): Promise<SubagentRunRow[]> {
    const runIds = new Set([...this.runs.values()].filter((run) => run.thread_id === threadId).map((run) => run.id));
    return [...this.subagentRuns.values()]
      .filter((row) => runIds.has(row.parent_run_id))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
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
    const row: ShellSessionRow = {
      id: newShellSessionId(),
      thread_id: input.threadId,
      name: input.name,
      owner: input.owner,
      workspace_root: input.workspaceRoot,
      cwd: input.cwd ?? input.workspaceRoot,
      backend: input.backend,
      status: 'idle',
      lease_actor: null,
      lease_run_id: null,
      config_snapshot: input.configSnapshot ?? null,
      deleted_at: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.shellSessions.set(row.id, row);
    return row;
  }

  async getShellSession(id: string): Promise<ShellSessionRow | null> {
    return this.shellSessions.get(id) ?? null;
  }

  async listShellSessions(threadId: string, workspaceRoot?: string): Promise<ShellSessionRow[]> {
    return [...this.shellSessions.values()]
      .filter((session) => !session.deleted_at && session.thread_id === threadId && (!workspaceRoot || session.workspace_root === workspaceRoot))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async updateShellSession(
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void> {
    const row = this.shellSessions.get(id);
    if (!row) return;
    Object.assign(row, fields, { updated_at: this.now() });
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
    const alreadyRunning = [...this.shellCommands.values()].find(
      (cmd) => cmd.session_id === input.sessionId && (cmd.status === 'queued' || cmd.status === 'running'),
    );
    if (alreadyRunning) throw new Error(`shell session 正在执行命令 ${alreadyRunning.id}`);
    const row: ShellCommandRow = {
      id: newShellCommandId(),
      session_id: input.sessionId,
      run_id: input.runId ?? null,
      step_id: input.stepId ?? null,
      actor: input.actor,
      command: input.command,
      cwd: input.cwd,
      wait_mode: input.waitMode,
      status: 'queued',
      attention: null,
      host_pid: null,
      child_pid: null,
      exit_code: null,
      signal: null,
      soft_timeout_ms: input.softTimeoutMs ?? null,
      hard_timeout_ms: input.hardTimeoutMs ?? null,
      soft_timeout_at: input.softTimeoutAt ?? null,
      hard_timeout_at: input.hardTimeoutAt ?? null,
      last_output_at: null,
      output_bytes: 0,
      error: null,
      started_at: this.now(),
      ended_at: null,
      updated_at: this.now(),
    };
    this.shellCommands.set(row.id, row);
    return row;
  }

  async getShellCommand(id: string): Promise<ShellCommandRow | null> {
    return this.shellCommands.get(id) ?? null;
  }

  async listShellCommandsBySession(sessionId: string, limit = 20): Promise<ShellCommandRow[]> {
    return [...this.shellCommands.values()]
      .filter((cmd) => cmd.session_id === sessionId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit);
  }

  async listRunningShellCommandsByRun(runId: string): Promise<ShellCommandRow[]> {
    return [...this.shellCommands.values()].filter((cmd) => cmd.run_id === runId && cmd.status === 'running');
  }

  async listRunningShellCommands(): Promise<ShellCommandRow[]> {
    return [...this.shellCommands.values()].filter((cmd) => cmd.status === 'queued' || cmd.status === 'running');
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
    const row = this.shellCommands.get(id);
    if (!row) return;
    Object.assign(row, fields, { updated_at: this.now() });
  }

  async appendShellCommandLog(commandId: string, stream: ShellLogStream, chunk: string): Promise<ShellCommandLogRow> {
    const list = this.shellLogs.get(commandId) ?? [];
    const row: ShellCommandLogRow = {
      id: ++this.shellLogSeq,
      command_id: commandId,
      seq: list.length ? list[list.length - 1].seq + 1 : 1,
      stream,
      chunk,
      created_at: this.now(),
    };
    list.push(row);
    this.shellLogs.set(commandId, list);
    return row;
  }

  async getShellCommandLogs(commandId: string, sinceSeq = 0, limit = 200): Promise<ShellCommandLogRow[]> {
    return (this.shellLogs.get(commandId) ?? []).filter((row) => row.seq > sinceSeq).slice(0, limit);
  }

  async addShellSessionEvent(_sessionId: string, _actor: ShellActor, _kind: string, _data: unknown): Promise<void> {
    // 内存 Store 只服务单测和离线演示；session 事件的可视化依赖 AgentEvent。
  }
}
