import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder, maskToolCallArguments } from '../agent/compaction.js';
import type { GoalState } from '../agent/goal.js';
import { sanitizeThreadMessagesForModel } from './messageView.js';
import type {
  PushSubscriptionRow,
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
import type { WebPushSubscriptionInput } from '@my-agent/contracts';
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
  private threadNotices = new Map<string, ThreadNoticeRow[]>();
  private pushSubscriptions = new Map<string, PushSubscriptionRow>();
  private seq = 0;
  private shellLogSeq = 0;
  private now = () => new Date().toISOString();

  private threadWithFallbackTitle(thread: ThreadRow): ThreadRow {
    const firstRun = [...this.runs.values()]
      .filter((run) => run.thread_id === thread.id)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))[0];
    return { ...thread, fallback_title: firstRun?.input ?? null };
  }

  async createThread(title?: string): Promise<ThreadRow> {
    const row: ThreadRow = {
      id: newThreadId(),
      title: title ?? null,
      active_run_id: null,
      pinned_at: null,
      archived_at: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.threads.set(row.id, row);
    return row;
  }
  async getThread(id: string) {
    const thread = this.threads.get(id);
    return thread ? this.threadWithFallbackTitle(thread) : null;
  }
  async listThreads(limit = 50, options: { archived?: boolean } = {}) {
    const archived = options.archived === true;
    return [...this.threads.values()]
      .filter((thread) => archived ? Boolean(thread.archived_at) : !thread.archived_at)
      .sort((a, b) => {
        if (a.pinned_at && !b.pinned_at) return -1;
        if (!a.pinned_at && b.pinned_at) return 1;
        const pinDiff = Date.parse(b.pinned_at ?? '') - Date.parse(a.pinned_at ?? '');
        if (Number.isFinite(pinDiff) && pinDiff !== 0) return pinDiff;
        const updateDiff = Date.parse(b.updated_at) - Date.parse(a.updated_at);
        return updateDiff || Date.parse(b.created_at) - Date.parse(a.created_at);
      })
      .map((thread) => this.threadWithFallbackTitle(thread))
      .slice(0, limit);
  }
  async updateThread(id: string, fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null }) {
    const thread = this.threads.get(id);
    if (!thread) return null;
    let activeRunId = fields.activeRunId ?? null;
    if (fields.activeRunId) {
      activeRunId = this.resolveBranchLeafRunId(id, fields.activeRunId);
      if (!activeRunId) return null;
    }
    const now = this.now();
    const next: ThreadRow = {
      ...thread,
      title: Object.prototype.hasOwnProperty.call(fields, 'title') ? fields.title ?? null : thread.title,
      pinned_at: fields.pinned === undefined ? thread.pinned_at : fields.pinned ? thread.pinned_at ?? now : null,
      archived_at: fields.archived === undefined ? thread.archived_at : fields.archived ? thread.archived_at ?? now : null,
      active_run_id: Object.prototype.hasOwnProperty.call(fields, 'activeRunId') ? activeRunId : thread.active_run_id,
      updated_at: now,
    };
    this.threads.set(id, next);
    return next;
  }
  async setThreadTitleIfEmpty(id: string, title: string) {
    const thread = this.threads.get(id);
    if (!thread || thread.title?.trim()) return null;
    const next: ThreadRow = { ...thread, title, updated_at: this.now() };
    this.threads.set(id, next);
    return next;
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
    this.threadNotices.delete(id);
    return true;
  }

  async searchThreadMessages(searchText: string, limit = 50): Promise<ThreadSearchResultRow[]> {
    const q = searchText.trim().toLowerCase();
    if (!q) return [];
    return this.messages
      .filter((message) => (
        (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && message.content.toLowerCase().includes(q)
      ))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map((message) => ({
        thread_id: message.thread_id,
        thread_title: this.threads.get(message.thread_id)?.title ?? null,
        run_id: message.run_id,
        message_id: message.seq,
        role: message.role as 'user' | 'assistant',
        content: message.content ?? '',
        created_at: this.runs.get(message.run_id)?.created_at ?? this.now(),
      }));
  }

  async listThreadNotices(threadId: string): Promise<ThreadNoticeRow[]> {
    return [...(this.threadNotices.get(threadId) ?? [])];
  }

  async addThreadNotice(input: {
    threadId: string;
    kind?: string;
    message: string;
    title?: string | null;
    linkedThreadId?: string | null;
    linkedRunId?: string | null;
  }): Promise<ThreadNoticeRow> {
    const row: ThreadNoticeRow = {
      id: this.seq++,
      thread_id: input.threadId,
      kind: input.kind ?? 'info',
      message: input.message,
      title: input.title ?? null,
      linked_thread_id: input.linkedThreadId ?? null,
      linked_run_id: input.linkedRunId ?? null,
      created_at: this.now(),
    };
    this.threadNotices.set(input.threadId, [...(this.threadNotices.get(input.threadId) ?? []), row]);
    return row;
  }

  async forkThreadAtRun(sourceRunId: string): Promise<{ thread: ThreadRow; activeRun: RunRow } | null> {
    const source = this.runs.get(sourceRunId);
    if (!source) return null;
    const sourceThread = this.threads.get(source.thread_id);
    if (!sourceThread) return null;

    const path: RunRow[] = [];
    const seen = new Set<string>();
    let cursor: string | null = source.id;
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const run = this.runs.get(cursor);
      if (!run || run.thread_id !== source.thread_id) break;
      path.push(run);
      cursor = run.parent_run_id;
    }
    path.reverse();

    const newThread = await this.createThread(sourceThread.title ? `${sourceThread.title} 的 fork` : 'Fork 对话');
    const runIdMap = new Map<string, string>();
    const stepIdMap = new Map<string, string>();
    const messageIdMap = new Map<number, number>();
    let activeRun: RunRow | null = null;

    for (const oldRun of path) {
      const parentRunId = oldRun.parent_run_id ? runIdMap.get(oldRun.parent_run_id) ?? null : null;
      const isSourceRun = oldRun.id === source.id;
      const newRun = await this.createRun(newThread.id, oldRun.input, { modelRef: oldRun.model_ref, parentRunId });
      newRun.status = isSourceRun ? 'done' : oldRun.status;
      newRun.output = isSourceRun ? null : oldRun.output;
      newRun.error = isSourceRun ? null : oldRun.error;
      newRun.goal_state = oldRun.goal_state;
      newRun.created_at = oldRun.created_at;
      newRun.updated_at = oldRun.updated_at;
      runIdMap.set(oldRun.id, newRun.id);
      activeRun = newRun;

      if (!isSourceRun) {
        for (const oldStep of this.steps.filter((step) => step.run_id === oldRun.id).sort((a, b) => a.idx - b.idx)) {
          const newStep: StepRow = { ...oldStep, id: newStepId(), run_id: newRun.id };
          this.steps.push(newStep);
          stepIdMap.set(oldStep.id, newStep.id);
        }
      }

      const oldMessages = this.messages
        .filter((message) => (
          message.run_id === oldRun.id
          && (!isSourceRun || (message.step_id === null && message.role === 'user'))
        ))
        .sort((a, b) => a.seq - b.seq);
      for (const oldMessage of oldMessages) {
        const seq = this.seq++;
        const copied: StoredMsg = {
          ...oldMessage,
          thread_id: newThread.id,
          run_id: newRun.id,
          step_id: oldMessage.step_id ? stepIdMap.get(oldMessage.step_id) ?? null : null,
          summaryOf: oldMessage.summaryOf?.map((id) => messageIdMap.get(id)).filter((id): id is number => id != null),
          seq,
        };
        this.messages.push(copied);
        messageIdMap.set(oldMessage.seq, seq);
      }

      if (!isSourceRun) {
        const oldEvents = this.events.get(oldRun.id) ?? [];
        this.events.set(newRun.id, [...oldEvents]);
      }
    }

    if (!activeRun) return null;
    newThread.active_run_id = activeRun.id;
    newThread.updated_at = this.now();
    await this.addThreadNotice({
      threadId: source.thread_id,
      kind: 'fork_to',
      message: '已从本消息 fork 到新对话。',
      title: newThread.title ?? '新对话',
      linkedThreadId: newThread.id,
      linkedRunId: source.id,
    });
    await this.addThreadNotice({
      threadId: newThread.id,
      kind: 'fork_from',
      message: '此对话 fork 自原对话。',
      title: sourceThread.title ?? '未命名对话',
      linkedThreadId: source.thread_id,
      linkedRunId: activeRun.id,
    });
    return { thread: newThread, activeRun };
  }

  async createRun(threadId: string, input: string, options: { modelRef?: string | null; parentRunId?: string | null } = {}): Promise<RunRow> {
    const thread = this.threads.get(threadId);
    const threadRuns = [...this.runs.values()].filter((r) => r.thread_id === threadId);
    const parentRunId = options.parentRunId === undefined
      ? thread?.active_run_id ?? threadRuns[threadRuns.length - 1]?.id ?? null
      : options.parentRunId;
    if (parentRunId && this.runs.get(parentRunId)?.thread_id !== threadId) throw new Error('parentRunId 不属于当前 thread');
    const row: RunRow = {
      id: newRunId(),
      thread_id: threadId,
      parent_run_id: parentRunId ?? null,
      status: 'pending',
      input,
      model_ref: options.modelRef ?? null,
      output: null,
      error: null,
      goal_state: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.runs.set(row.id, row);
    if (thread) {
      thread.active_run_id = row.id;
      thread.updated_at = this.now();
    }
    return row;
  }

  private resolveBranchLeafRunId(threadId: string, selectedRunId: string): string | null {
    const selected = this.runs.get(selectedRunId);
    if (!selected || selected.thread_id !== threadId) return null;
    const runs = [...this.runs.values()].filter((run) => run.thread_id === threadId);
    const childrenByParent = new Map<string | null, RunRow[]>();
    for (const run of runs) {
      childrenByParent.set(run.parent_run_id, [...(childrenByParent.get(run.parent_run_id) ?? []), run]);
    }
    const subtree: RunRow[] = [];
    const stack = [selected];
    const seen = new Set<string>();
    while (stack.length) {
      const run = stack.pop()!;
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      subtree.push(run);
      stack.push(...(childrenByParent.get(run.id) ?? []));
    }
    const subtreeIds = new Set(subtree.map((run) => run.id));
    return subtree
      .filter((run) => !(childrenByParent.get(run.id) ?? []).some((child) => subtreeIds.has(child.id)))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))[0]?.id ?? selectedRunId;
  }

  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  async listRuns(threadId: string) {
    return [...this.runs.values()].filter((r) => r.thread_id === threadId).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
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

  private branchRunIds(threadId: string, runId?: string | null): Set<string> {
    const thread = this.threads.get(threadId);
    let cursor = runId ?? thread?.active_run_id ?? null;
    if (!cursor) {
      return new Set([...this.runs.values()].filter((run) => run.thread_id === threadId).map((run) => run.id));
    }
    const ids = new Set<string>();
    while (cursor) {
      const run = this.runs.get(cursor);
      if (!run || run.thread_id !== threadId || ids.has(run.id)) break;
      ids.add(run.id);
      cursor = run.parent_run_id;
    }
    return ids;
  }

  async loadThreadMessages(threadId: string, options: { runId?: string | null } = {}): Promise<ThreadMessage[]> {
    const branchRunIds = this.branchRunIds(threadId, options.runId);
    const messages = this.messages
      .filter((m) => branchRunIds.has(m.run_id) && m.thread_id === threadId && m.collapsed !== 'summarized' && !isEphemeralSystemMessage(m.role, m.content))
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
    return sanitizeThreadMessagesForModel(messages);
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

  async upsertPushSubscription(input: WebPushSubscriptionInput, userAgent?: string | null): Promise<PushSubscriptionRow> {
    const existing = this.pushSubscriptions.get(input.endpoint);
    const now = this.now();
    const row: PushSubscriptionRow = {
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      expiration_time: input.expirationTime ? new Date(input.expirationTime).toISOString() : null,
      user_agent: userAgent ?? null,
      enabled: true,
      last_error: null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.pushSubscriptions.set(input.endpoint, row);
    return row;
  }

  async listEnabledPushSubscriptions(): Promise<PushSubscriptionRow[]> {
    return [...this.pushSubscriptions.values()].filter((row) => row.enabled);
  }

  async disablePushSubscription(endpoint: string, error?: string | null): Promise<void> {
    const row = this.pushSubscriptions.get(endpoint);
    if (!row) return;
    this.pushSubscriptions.set(endpoint, { ...row, enabled: false, last_error: error ?? null, updated_at: this.now() });
  }
}
