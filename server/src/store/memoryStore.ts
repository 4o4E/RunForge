import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder, maskToolCallArguments } from '../agent/compaction.js';
import type { GoalState } from '../agent/goal.js';
import type { RunRow, Store, StepRow, ThreadMessage, ThreadRow } from './types.js';
import { newRunId, newStepId, newThreadId } from '../id.js';

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
  private seq = 0;
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
}
