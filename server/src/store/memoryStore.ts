import { randomUUID } from 'node:crypto';
import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import type { RunRow, Store, StepRow, ThreadRow } from './types.js';

interface StoredMsg {
  thread_id: string;
  role: LlmMessage['role'];
  content: string | null;
  toolCalls?: LlmMessage['toolCalls'];
  toolCallId?: string;
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
    const row: ThreadRow = { id: randomUUID(), title: title ?? null, created_at: this.now(), updated_at: this.now() };
    this.threads.set(row.id, row);
    return row;
  }
  async getThread(id: string) {
    return this.threads.get(id) ?? null;
  }
  async listThreads(limit = 50) {
    return [...this.threads.values()].slice(0, limit);
  }

  async createRun(threadId: string, input: string): Promise<RunRow> {
    const row: RunRow = {
      id: randomUUID(),
      thread_id: threadId,
      status: 'pending',
      input,
      output: null,
      error: null,
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
  async setRunStatus(id: string, status: RunStatus, fields: { output?: string; error?: string } = {}) {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = status;
    if (fields.output !== undefined) run.output = fields.output;
    if (fields.error !== undefined) run.error = fields.error;
    run.updated_at = this.now();
  }

  async createStep(runId: string, idx: number): Promise<StepRow> {
    const row: StepRow = { id: randomUUID(), run_id: runId, idx, created_at: this.now() };
    this.steps.push(row);
    return row;
  }

  async loadThreadMessages(threadId: string): Promise<LlmMessage[]> {
    return this.messages
      .filter((m) => m.thread_id === threadId)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.toolCallId }));
  }
  async addMessage(threadId: string, _runId: string, _stepId: string | null, msg: LlmMessage) {
    this.messages.push({
      thread_id: threadId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      seq: this.seq++,
    });
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
