import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import { maskPlaceholder, maskToolCallArguments } from '../agent/compaction.js';
import type { GoalState } from '../agent/goal.js';
import { sanitizeThreadMessagesForModel } from './messageView.js';
import { DefaultSpaceImmutableError, isTerminalRunStatus, RunActiveError, SpaceConfigChangedError } from './types.js';
import type {
  AuthTokenRow,
  CreateRunOptions,
  CreateSpaceRecordInput,
  CreateTenantWithOwnerInput,
  PushSubscriptionRow,
  RawThreadMessage,
  RunRow,
  Scope,
  ShellActor,
  ShellCommandLogRow,
  ShellCommandRow,
  ShellLogStream,
  ShellSessionRow,
  SpaceRow,
  SpaceWithVisibilityRow,
  Store,
  SubagentRunRow,
  StepRow,
  SystemAdminRow,
  SystemAdminTokenRow,
  TenantRow,
  ThreadNoticeRow,
  ThreadMessage,
  ThreadMessageMetadata,
  ThreadSearchResultRow,
  ThreadRow,
  UserRow,
  UpdateSpaceRecordInput,
} from './types.js';
import type { TenantUserRole, WebPushSubscriptionInput } from '@runforge/contracts';
import {
  newAuthTokenId,
  newRunId,
  newShellCommandId,
  newShellSessionId,
  newSpaceId,
  newStepId,
  newSubagentRunId,
  newSystemAdminId,
  newSystemAdminTokenId,
  newThreadId,
  newUserId,
} from '../id.js';

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
  providerState?: LlmMessage['providerState'];
  collapsed?: 'masked' | 'summarized';
  summaryOf?: number[];
  seq: number;
  created_at: string;
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
  private tenants = new Map<string, TenantRow>();
  private spaces = new Map<string, SpaceRow>();
  private spaceVisibleUsers = new Map<string, Set<string>>();
  private users = new Map<string, UserRow>();
  private systemAdmins = new Map<string, SystemAdminRow>();
  private authTokens = new Map<string, AuthTokenRow>();
  private systemAdminTokens = new Map<string, SystemAdminTokenRow>();
  private seq = 0;
  private shellLogSeq = 0;
  private now = () => new Date().toISOString();

  // 多租户改造 Phase 2(docs/multi-tenancy-design.md §5)。这几个私有归属判断函数
  // 镜像 pgStore.ts 里对应的 JOIN 链,保持两个实现的过滤逻辑一致。
  private threadOwnedBy(thread: ThreadRow | undefined, scope: Scope): thread is ThreadRow {
    return Boolean(thread) && thread!.tenant_id === scope.tenantId && thread!.user_id === scope.userId;
  }
  private runOwnedBy(run: RunRow | undefined, scope: Scope): run is RunRow {
    if (!run) return false;
    return this.threadOwnedBy(this.threads.get(run.thread_id), scope);
  }
  private shellSessionOwnedBy(session: ShellSessionRow | undefined, scope: Scope): session is ShellSessionRow {
    if (!session) return false;
    return this.threadOwnedBy(this.threads.get(session.thread_id), scope);
  }
  private shellCommandOwnedBy(command: ShellCommandRow | undefined, scope: Scope): command is ShellCommandRow {
    if (!command) return false;
    return this.shellSessionOwnedBy(this.shellSessions.get(command.session_id), scope);
  }
  private subagentRunOwnedBy(row: SubagentRunRow | undefined, scope: Scope): row is SubagentRunRow {
    if (!row) return false;
    return this.runOwnedBy(this.runs.get(row.parent_run_id), scope);
  }

  private threadWithFallbackTitle(thread: ThreadRow): ThreadRow {
    const firstRun = [...this.runs.values()]
      .filter((run) => run.thread_id === thread.id)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))[0];
    return { ...thread, fallback_title: firstRun?.input ?? null };
  }

  private spaceWithVisibility(space: SpaceRow): SpaceWithVisibilityRow {
    return {
      ...space,
      config: structuredClone(space.config),
      visible_user_ids: [...(this.spaceVisibleUsers.get(space.id) ?? [])].sort(),
    };
  }

  /** 大量纯单元测试直接从 createThread 开始，不需要先搭身份数据。只在 MemoryStore
   *  内补一个最小 default space；真实 PgStore 始终要求 tenant/user 已存在。 */
  private ensureDefaultSpaceForTests(scope: Scope): SpaceRow {
    let tenant = this.tenants.get(scope.tenantId);
    if (tenant?.default_space_id) {
      const existing = this.spaces.get(tenant.default_space_id);
      if (existing) return existing;
    }
    const now = this.now();
    const space: SpaceRow = {
      id: newSpaceId(),
      tenant_id: scope.tenantId,
      mode: 'web',
      name: 'Default',
      execution_user_id: null,
      config: {},
      config_version: 1,
      created_by_user_id: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    if (!tenant) {
      tenant = {
        id: scope.tenantId,
        name: scope.tenantId,
        status: 'active',
        default_space_id: space.id,
        created_at: now,
      };
      this.tenants.set(tenant.id, tenant);
    } else {
      tenant.default_space_id = space.id;
    }
    this.spaces.set(space.id, space);
    this.spaceVisibleUsers.set(space.id, new Set());
    return space;
  }

  async createThread(scope: Scope, title?: string, options: { spaceId?: string } = {}): Promise<ThreadRow> {
    const space = options.spaceId ? this.spaces.get(options.spaceId) : this.ensureDefaultSpaceForTests(scope);
    if (!space || space.tenant_id !== scope.tenantId || space.mode !== 'web' || space.deleted_at) {
      throw new Error('space 不存在、已删除或不允许创建 Web 对话');
    }
    const user = this.users.get(scope.userId);
    if (user) {
      const canManage = user.status === 'active' && (user.role === 'owner' || user.role === 'admin');
      const isVisible = user.status === 'active' && this.spaceVisibleUsers.get(space.id)?.has(user.id);
      if (!canManage && !isVisible) throw new Error('space 不存在或当前用户不可写');
    }
    const row: ThreadRow = {
      id: newThreadId(),
      tenant_id: scope.tenantId,
      user_id: scope.userId,
      space_id: space.id,
      source_type: 'web',
      source_caller_id: null,
      source_ref: {},
      title: title ?? null,
      active_run_id: null,
      executing_run_id: null,
      pinned_at: null,
      archived_at: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.threads.set(row.id, row);
    return row;
  }
  async getThread(scope: Scope, id: string) {
    const thread = this.threads.get(id);
    if (!this.threadOwnedBy(thread, scope)) return null;
    return this.threadWithFallbackTitle(thread);
  }
  async listThreads(scope: Scope, limit = 50, options: { archived?: boolean; spaceIds?: string[] } = {}) {
    const archived = options.archived === true;
    const allowedSpaces = options.spaceIds ? new Set(options.spaceIds) : null;
    return [...this.threads.values()]
      .filter((thread) => thread.tenant_id === scope.tenantId && thread.user_id === scope.userId)
      .filter((thread) => !allowedSpaces || allowedSpaces.has(thread.space_id))
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
  async updateThread(scope: Scope, id: string, fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null }) {
    const thread = this.threads.get(id);
    if (!this.threadOwnedBy(thread, scope)) return null;
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
  async setThreadTitleIfEmpty(scope: Scope, id: string, title: string) {
    const thread = this.threads.get(id);
    if (!this.threadOwnedBy(thread, scope) || thread.title?.trim()) return null;
    const next: ThreadRow = { ...thread, title, updated_at: this.now() };
    this.threads.set(id, next);
    return next;
  }
  async deleteThread(scope: Scope, id: string) {
    const thread = this.threads.get(id);
    if (!this.threadOwnedBy(thread, scope)) return false;
    this.threads.delete(id);
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

  async searchThreadMessages(
    scope: Scope,
    searchText: string,
    limit = 50,
    options: { spaceIds?: string[] } = {},
  ): Promise<ThreadSearchResultRow[]> {
    const q = searchText.trim().toLowerCase();
    if (!q) return [];
    const allowedSpaces = options.spaceIds ? new Set(options.spaceIds) : null;
    return this.messages
      .filter((message) => this.threadOwnedBy(this.threads.get(message.thread_id), scope))
      .filter((message) => {
        const thread = this.threads.get(message.thread_id);
        return !allowedSpaces || Boolean(thread && allowedSpaces.has(thread.space_id));
      })
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

  async listThreadNotices(scope: Scope, threadId: string): Promise<ThreadNoticeRow[]> {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) return [];
    return [...(this.threadNotices.get(threadId) ?? [])];
  }

  async addThreadNotice(scope: Scope, input: {
    threadId: string;
    kind?: string;
    message: string;
    title?: string | null;
    linkedThreadId?: string | null;
    linkedRunId?: string | null;
  }): Promise<ThreadNoticeRow> {
    if (!this.threadOwnedBy(this.threads.get(input.threadId), scope)) throw new Error('threadId 不存在或不属于当前用户');
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

  async forkThreadAtRun(scope: Scope, sourceRunId: string): Promise<{ thread: ThreadRow; activeRun: RunRow } | null> {
    const source = this.runs.get(sourceRunId);
    if (!this.runOwnedBy(source, scope)) return null;
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

    // fork 出的新 thread 归属发起 fork 的 scope,不是复制源 thread 的归属——
    // 能走到这里说明 sourceRunId 已经属于 scope 了,两者本来就是同一个 tenant/user。
    const newThread = await this.createThread(
      scope,
      sourceThread.title ? `${sourceThread.title} 的 fork` : 'Fork 对话',
      { spaceId: sourceThread.space_id },
    );
    const runIdMap = new Map<string, string>();
    const stepIdMap = new Map<string, string>();
    const messageIdMap = new Map<number, number>();
    let activeRun: RunRow | null = null;

    for (const oldRun of path) {
      const parentRunId = oldRun.parent_run_id ? runIdMap.get(oldRun.parent_run_id) ?? null : null;
      const isSourceRun = oldRun.id === source.id;
      const newRun = await this.createRun(scope, newThread.id, oldRun.input, { modelRef: oldRun.model_ref, parentRunId });
      const copiedStatus = isSourceRun ? 'done' : isTerminalRunStatus(oldRun.status) ? oldRun.status : 'error';
      await this.setRunStatus(scope, newRun.id, copiedStatus, {
        output: isSourceRun ? null : oldRun.output,
        error: isSourceRun ? null : copiedStatus === 'error' ? oldRun.error ?? 'fork 时停止了历史非终态 run。' : oldRun.error,
      });
      newRun.goal_state = oldRun.goal_state;
      newRun.runtime_capabilities_snapshot = structuredClone(oldRun.runtime_capabilities_snapshot);
      newRun.space_config_snapshot = structuredClone(oldRun.space_config_snapshot);
      newRun.space_config_version = oldRun.space_config_version;
      newRun.plugin_lock = structuredClone(oldRun.plugin_lock);
      newRun.external_input_open = false;
      newRun.input_version = oldRun.input_version;
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
    await this.addThreadNotice(scope, {
      threadId: source.thread_id,
      kind: 'fork_to',
      message: '已从本消息 fork 到新对话。',
      title: newThread.title ?? '新对话',
      linkedThreadId: newThread.id,
      linkedRunId: source.id,
    });
    await this.addThreadNotice(scope, {
      threadId: newThread.id,
      kind: 'fork_from',
      message: '此对话 fork 自原对话。',
      title: sourceThread.title ?? '未命名对话',
      linkedThreadId: source.thread_id,
      linkedRunId: activeRun.id,
    });
    return { thread: newThread, activeRun };
  }

  async createRun(scope: Scope, threadId: string, input: string, options: CreateRunOptions = {}): Promise<RunRow> {
    const thread = this.threads.get(threadId);
    if (!this.threadOwnedBy(thread, scope)) throw new Error('threadId 不存在或不属于当前用户');
    const space = this.spaces.get(thread.space_id);
    if (!space || space.deleted_at) throw new Error('space 已删除，不能创建新 run');
    if (space.mode !== 'web') throw new Error('外部空间在 Web 中只读');
    if (options.expectedSpaceConfigVersion !== undefined && options.expectedSpaceConfigVersion !== space.config_version) {
      throw new SpaceConfigChangedError();
    }
    const user = this.users.get(scope.userId);
    if (user) {
      const canManage = user.status === 'active' && (user.role === 'owner' || user.role === 'admin');
      const isVisible = user.status === 'active' && this.spaceVisibleUsers.get(space.id)?.has(user.id);
      if (!canManage && !isVisible) throw new Error('space 不存在或当前用户不可写');
    }
    if (thread.executing_run_id) {
      const current = this.runs.get(thread.executing_run_id);
      throw new RunActiveError(thread.executing_run_id, current?.status ?? 'running');
    }
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
      runtime_capabilities_snapshot: options.runtimeCapabilitiesSnapshot ?? null,
      space_config_snapshot: structuredClone(options.spaceConfigSnapshot ?? space.config),
      space_config_version: space.config_version,
      plugin_lock: null,
      external_input_open: false,
      input_version: 0,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.runs.set(row.id, row);
    if (thread) {
      thread.active_run_id = row.id;
      thread.executing_run_id = row.id;
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

  async getRun(scope: Scope, id: string) {
    const run = this.runs.get(id);
    return this.runOwnedBy(run, scope) ? run : null;
  }
  async listRuns(scope: Scope, threadId: string) {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) return [];
    return [...this.runs.values()].filter((r) => r.thread_id === threadId).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }
  async listRunsByStatusUnscoped(statuses: RunStatus[]) {
    const set = new Set(statuses);
    return [...this.runs.values()].filter((r) => set.has(r.status));
  }
  async setRunStatus(scope: Scope, id: string, status: RunStatus, fields: { output?: string | null; error?: string | null } = {}) {
    const run = this.runs.get(id);
    if (!this.runOwnedBy(run, scope)) return;
    const thread = this.threads.get(run.thread_id)!;
    if (!isTerminalRunStatus(status)) {
      if (thread.executing_run_id && thread.executing_run_id !== id) {
        const current = this.runs.get(thread.executing_run_id);
        throw new RunActiveError(thread.executing_run_id, current?.status ?? 'running');
      }
      thread.executing_run_id = id;
    }
    run.status = status;
    if (fields.output !== undefined) run.output = fields.output;
    if (fields.error !== undefined) run.error = fields.error;
    run.updated_at = this.now();
    if (isTerminalRunStatus(status) && thread.executing_run_id === id) {
      thread.executing_run_id = null;
    }
  }
  async resumeRun(
    scope: Scope,
    id: string,
    expectedStatuses: RunStatus[],
    fields: { output?: string | null; error?: string | null; userMessageContent?: string } = {},
  ): Promise<RunRow | null> {
    const run = this.runs.get(id);
    if (!this.runOwnedBy(run, scope) || !expectedStatuses.includes(run.status)) return null;
    const thread = this.threads.get(run.thread_id)!;
    if (run.status === 'pending' && thread.executing_run_id === id) {
      throw new RunActiveError(id, 'pending');
    }
    if (thread.executing_run_id && thread.executing_run_id !== id) {
      const current = this.runs.get(thread.executing_run_id);
      throw new RunActiveError(thread.executing_run_id, current?.status ?? 'running');
    }
    run.status = 'pending';
    if (fields.output !== undefined) run.output = fields.output;
    if (fields.error !== undefined) run.error = fields.error;
    run.updated_at = this.now();
    thread.executing_run_id = id;
    if (fields.userMessageContent !== undefined) {
      this.messages.push({
        thread_id: run.thread_id,
        run_id: run.id,
        step_id: null,
        role: 'user',
        content: fields.userMessageContent,
        seq: this.seq++,
        created_at: this.now(),
      });
    }
    return run;
  }
  async setGoalState(scope: Scope, runId: string, goal: GoalState) {
    const run = this.runs.get(runId);
    if (!this.runOwnedBy(run, scope)) return;
    run.goal_state = goal;
    run.updated_at = this.now();
  }
  async setRuntimeCapabilitiesSnapshot(scope: Scope, runId: string, snapshot: object) {
    const run = this.runs.get(runId);
    if (!this.runOwnedBy(run, scope)) return;
    run.runtime_capabilities_snapshot = structuredClone(snapshot) as Record<string, unknown>;
    run.updated_at = this.now();
  }
  async getRunUnscoped(id: string): Promise<RunRow | null> {
    return this.runs.get(id) ?? null;
  }
  async getThreadUnscoped(id: string): Promise<ThreadRow | null> {
    return this.threads.get(id) ?? null;
  }

  async createStep(scope: Scope, runId: string, idx: number): Promise<StepRow> {
    if (!this.runOwnedBy(this.runs.get(runId), scope)) throw new Error('runId 不存在或不属于当前用户');
    const row: StepRow = { id: newStepId(), run_id: runId, idx, created_at: this.now() };
    this.steps.push(row);
    return row;
  }
  async getLastStepIndex(scope: Scope, runId: string): Promise<number> {
    if (!this.runOwnedBy(this.runs.get(runId), scope)) return 0;
    return this.steps.filter((s) => s.run_id === runId).reduce((max, s) => Math.max(max, s.idx), 0);
  }
  async getLastCompletedStepIndex(scope: Scope, runId: string): Promise<number> {
    if (!this.runOwnedBy(this.runs.get(runId), scope)) return 0;
    let last = 0;
    for (const step of this.steps.filter((s) => s.run_id === runId).sort((a, b) => a.idx - b.idx)) {
      const stepMessages = this.messages.filter((m) => m.step_id === step.id);
      const assistantMessages = stepMessages.filter((m) => m.role === 'assistant');
      if (!assistantMessages.length) continue;
      const requiredToolIds = assistantMessages.flatMap((m) => (m.toolCalls ?? []).map((call) => call.id));
      const answeredToolIds = new Set(stepMessages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string));
      if (requiredToolIds.every((id) => answeredToolIds.has(id))) last = Math.max(last, step.idx);
    }
    return last;
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

  async loadThreadMessages(scope: Scope, threadId: string, options: { runId?: string | null } = {}): Promise<ThreadMessage[]> {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) return [];
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
        providerState: m.collapsed === 'masked' ? undefined : m.providerState,
        collapsed: m.collapsed,
      }));
    return sanitizeThreadMessagesForModel(messages);
  }
  async loadRawThreadMessages(scope: Scope, threadId: string, options: { runId?: string | null } = {}): Promise<RawThreadMessage[]> {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) return [];
    const branchRunIds = this.branchRunIds(threadId, options.runId);
    return this.messages
      .filter((message) => branchRunIds.has(message.run_id) && message.thread_id === threadId && !isEphemeralSystemMessage(message.role, message.content))
      .sort((a, b) => a.seq - b.seq)
      .map((message) => ({
        id: message.seq,
        run_id: message.run_id,
        step_id: message.step_id,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        providerState: message.providerState,
        collapsed: message.collapsed,
        summaryOf: message.summaryOf ?? [],
        created_at: message.created_at,
      }));
  }
  async loadThreadMessageMetadata(scope: Scope, threadId: string, options: { runId?: string | null } = {}): Promise<ThreadMessageMetadata[]> {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) return [];
    const branchRunIds = this.branchRunIds(threadId, options.runId);
    return this.messages
      .filter((message): message is StoredMsg & { collapsed: 'masked' | 'summarized' } => (
        branchRunIds.has(message.run_id)
        && message.thread_id === threadId
        && message.collapsed != null
        && !isEphemeralSystemMessage(message.role, message.content)
      ))
      .sort((a, b) => a.seq - b.seq)
      .map((message) => ({
        id: message.seq,
        run_id: message.run_id,
        step_id: message.step_id,
        role: message.role,
        toolCalls: (message.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name, argumentChars: call.arguments.length })),
        toolCallId: message.toolCallId ?? null,
        collapsed: message.collapsed,
        summaryOf: message.summaryOf ?? [],
        contentChars: message.content?.length ?? 0,
        created_at: message.created_at,
      }));
  }
  async countRunMessages(scope: Scope, runId: string): Promise<number> {
    if (!this.runOwnedBy(this.runs.get(runId), scope)) return 0;
    return this.messages.filter((m) => m.run_id === runId).length;
  }
  async addMessage(scope: Scope, threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number> {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) throw new Error('threadId 不存在或不属于当前用户');
    const seq = this.seq++;
    this.messages.push({
      thread_id: threadId,
      run_id: runId,
      step_id: stepId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      providerState: msg.providerState,
      seq,
      created_at: this.now(),
    });
    return seq;
  }
  async addSummaryMessage(
    scope: Scope,
    threadId: string,
    runId: string,
    stepId: string | null,
    msg: LlmMessage,
    summaryOf: number[],
  ): Promise<number> {
    const id = await this.addMessage(scope, threadId, runId, stepId, msg);
    const row = this.messages.find((m) => m.seq === id);
    if (row) row.summaryOf = summaryOf;
    return id;
  }

  async markMessagesCollapsed(scope: Scope, ids: number[], kind: 'masked' | 'summarized'): Promise<void> {
    const set = new Set(ids);
    for (const m of this.messages) {
      if (set.has(m.seq) && this.threadOwnedBy(this.threads.get(m.thread_id), scope)) m.collapsed = kind;
    }
  }

  async addEvent(scope: Scope, runId: string, _stepId: string | null, event: AgentEvent) {
    if (!this.runOwnedBy(this.runs.get(runId), scope)) return;
    const list = this.events.get(runId) ?? [];
    list.push(event);
    this.events.set(runId, list);
  }
  async getEvents(scope: Scope, runId: string) {
    if (!this.runOwnedBy(this.runs.get(runId), scope)) return [];
    return this.events.get(runId) ?? [];
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
    if (!this.runOwnedBy(this.runs.get(input.parentRunId), scope)) throw new Error('parentRunId 不存在或不属于当前用户');
    const now = this.now();
    const row: SubagentRunRow = {
      id: newSubagentRunId(),
      tenant_id: scope.tenantId,
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
    scope: Scope,
    id: string,
    fields: { status: 'done' | 'error'; output?: string | null; error?: string | null; usage?: Record<string, unknown> | null },
  ): Promise<void> {
    const row = this.subagentRuns.get(id);
    if (!this.subagentRunOwnedBy(row, scope)) return;
    row.status = fields.status;
    if (fields.output !== undefined) row.output = fields.output;
    if (fields.error !== undefined) row.error = fields.error;
    if (fields.usage !== undefined) row.usage = fields.usage;
    row.updated_at = this.now();
    row.finished_at = row.updated_at;
  }

  async getSubagentRun(scope: Scope, id: string): Promise<SubagentRunRow | null> {
    const row = this.subagentRuns.get(id);
    return this.subagentRunOwnedBy(row, scope) ? row : null;
  }

  async listSubagentRunsByThread(scope: Scope, threadId: string): Promise<SubagentRunRow[]> {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) return [];
    const runIds = new Set([...this.runs.values()].filter((run) => run.thread_id === threadId).map((run) => run.id));
    return [...this.subagentRuns.values()]
      .filter((row) => runIds.has(row.parent_run_id))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
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
    if (!this.threadOwnedBy(this.threads.get(input.threadId), scope)) throw new Error('threadId 不存在或不属于当前用户');
    const row: ShellSessionRow = {
      id: newShellSessionId(),
      tenant_id: scope.tenantId,
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

  async getShellSession(scope: Scope, id: string): Promise<ShellSessionRow | null> {
    const row = this.shellSessions.get(id);
    return this.shellSessionOwnedBy(row, scope) ? row : null;
  }

  async listShellSessions(scope: Scope, threadId: string, workspaceRoot?: string): Promise<ShellSessionRow[]> {
    if (!this.threadOwnedBy(this.threads.get(threadId), scope)) return [];
    return [...this.shellSessions.values()]
      .filter((session) => !session.deleted_at && session.thread_id === threadId && (!workspaceRoot || session.workspace_root === workspaceRoot))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async updateShellSession(
    scope: Scope,
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void> {
    const row = this.shellSessions.get(id);
    if (!this.shellSessionOwnedBy(row, scope)) return;
    Object.assign(row, fields, { updated_at: this.now() });
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
    if (!this.shellSessionOwnedBy(this.shellSessions.get(input.sessionId), scope)) throw new Error('sessionId 不存在或不属于当前用户');
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

  async getShellCommand(scope: Scope, id: string): Promise<ShellCommandRow | null> {
    const row = this.shellCommands.get(id);
    return this.shellCommandOwnedBy(row, scope) ? row : null;
  }

  async listShellCommandsBySession(scope: Scope, sessionId: string, limit = 20): Promise<ShellCommandRow[]> {
    if (!this.shellSessionOwnedBy(this.shellSessions.get(sessionId), scope)) return [];
    return [...this.shellCommands.values()]
      .filter((cmd) => cmd.session_id === sessionId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit);
  }

  async listRunningShellCommandsByRun(scope: Scope, runId: string): Promise<ShellCommandRow[]> {
    if (!this.runOwnedBy(this.runs.get(runId), scope)) return [];
    return [...this.shellCommands.values()].filter((cmd) => cmd.run_id === runId && cmd.status === 'running');
  }

  async listRunningShellCommandsUnscoped(): Promise<ShellCommandRow[]> {
    return [...this.shellCommands.values()].filter((cmd) => cmd.status === 'queued' || cmd.status === 'running');
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
    const row = this.shellCommands.get(id);
    if (!row) return;
    Object.assign(row, fields, { updated_at: this.now() });
  }

  async updateShellSessionUnscoped(
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void> {
    const row = this.shellSessions.get(id);
    if (!row) return;
    Object.assign(row, fields, { updated_at: this.now() });
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
    const row = this.shellCommands.get(id);
    if (!this.shellCommandOwnedBy(row, scope)) return;
    Object.assign(row, fields, { updated_at: this.now() });
  }

  async appendShellCommandLog(scope: Scope, commandId: string, stream: ShellLogStream, chunk: string): Promise<ShellCommandLogRow> {
    if (!this.shellCommandOwnedBy(this.shellCommands.get(commandId), scope)) throw new Error('commandId 不存在或不属于当前用户');
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

  async getShellCommandLogs(scope: Scope, commandId: string, sinceSeq = 0, limit = 200): Promise<ShellCommandLogRow[]> {
    if (!this.shellCommandOwnedBy(this.shellCommands.get(commandId), scope)) return [];
    return (this.shellLogs.get(commandId) ?? []).filter((row) => row.seq > sinceSeq).slice(0, limit);
  }

  async addShellSessionEvent(scope: Scope, sessionId: string, _actor: ShellActor, _kind: string, _data: unknown): Promise<void> {
    // 内存 Store 只服务单测和离线演示；session 事件的可视化依赖 AgentEvent。
    // 仍然校验归属,保持和 pgStore 一致的行为(非本租户/用户的 session 静默无效果)。
    void this.shellSessionOwnedBy(this.shellSessions.get(sessionId), scope);
  }

  async upsertPushSubscription(scope: Scope, input: WebPushSubscriptionInput, userAgent?: string | null): Promise<PushSubscriptionRow> {
    const existing = this.pushSubscriptions.get(input.endpoint);
    const now = this.now();
    const row: PushSubscriptionRow = {
      endpoint: input.endpoint,
      tenant_id: scope.tenantId,
      user_id: scope.userId,
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

  async listEnabledPushSubscriptionsByScope(scope: Scope): Promise<PushSubscriptionRow[]> {
    return [...this.pushSubscriptions.values()].filter((row) => row.enabled && row.tenant_id === scope.tenantId && row.user_id === scope.userId);
  }

  async disablePushSubscription(endpoint: string, error?: string | null): Promise<void> {
    const row = this.pushSubscriptions.get(endpoint);
    if (!row) return;
    this.pushSubscriptions.set(endpoint, { ...row, enabled: false, last_error: error ?? null, updated_at: this.now() });
  }

  async createTenantWithOwner(input: CreateTenantWithOwnerInput) {
    if (this.tenants.has(input.id)) throw new Error(`tenant ${input.id} 已存在`);
    const createdAt = this.now();
    const owner: UserRow = {
      id: newUserId(),
      tenant_id: input.id,
      email: input.ownerEmail,
      password_hash: input.ownerPasswordHash,
      role: 'owner',
      status: 'active',
      created_at: createdAt,
    };
    const defaultSpace: SpaceRow = {
      id: newSpaceId(),
      tenant_id: input.id,
      mode: 'web',
      name: 'Default',
      execution_user_id: null,
      config: {},
      config_version: 1,
      created_by_user_id: owner.id,
      deleted_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const tenant: TenantRow = {
      id: input.id,
      name: input.name,
      status: 'active',
      default_space_id: defaultSpace.id,
      created_at: createdAt,
    };
    this.tenants.set(tenant.id, tenant);
    this.users.set(owner.id, owner);
    this.spaces.set(defaultSpace.id, defaultSpace);
    this.spaceVisibleUsers.set(defaultSpace.id, new Set());
    return { tenant, owner, defaultSpace };
  }

  async findTenant(id: string): Promise<TenantRow | null> {
    return this.tenants.get(id) ?? null;
  }

  async listTenants(): Promise<TenantRow[]> {
    return [...this.tenants.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async updateTenantStatus(id: string, status: 'active' | 'suspended'): Promise<TenantRow | null> {
    const row = this.tenants.get(id);
    if (!row) return null;
    row.status = status;
    return row;
  }

  async getDefaultSpace(tenantId: string): Promise<SpaceRow | null> {
    const id = this.tenants.get(tenantId)?.default_space_id;
    return id ? this.spaces.get(id) ?? null : null;
  }

  async listSpaces(tenantId: string, options: { includeDeleted?: boolean } = {}): Promise<SpaceWithVisibilityRow[]> {
    return [...this.spaces.values()]
      .filter((space) => space.tenant_id === tenantId && (options.includeDeleted || !space.deleted_at))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((space) => this.spaceWithVisibility(space));
  }

  async findSpace(tenantId: string, id: string): Promise<SpaceWithVisibilityRow | null> {
    const space = this.spaces.get(id);
    return space?.tenant_id === tenantId ? this.spaceWithVisibility(space) : null;
  }

  async createSpace(input: CreateSpaceRecordInput): Promise<SpaceWithVisibilityRow> {
    if (!this.tenants.has(input.tenantId)) throw new Error('tenant 不存在');
    const now = this.now();
    const space: SpaceRow = {
      id: newSpaceId(),
      tenant_id: input.tenantId,
      mode: input.mode,
      name: input.name,
      execution_user_id: input.executionUserId,
      config: structuredClone(input.config),
      config_version: 1,
      created_by_user_id: input.createdByUserId,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    this.spaces.set(space.id, space);
    this.spaceVisibleUsers.set(space.id, new Set(input.visibleUserIds));
    return this.spaceWithVisibility(space);
  }

  async updateSpace(tenantId: string, id: string, fields: UpdateSpaceRecordInput): Promise<SpaceWithVisibilityRow | null> {
    const space = this.spaces.get(id);
    if (!space || space.tenant_id !== tenantId) return null;
    const tenant = this.tenants.get(tenantId);
    if (tenant?.default_space_id === id && fields.name !== undefined && fields.name !== space.name) {
      throw new DefaultSpaceImmutableError('default 空间不能重命名');
    }
    if (fields.name !== undefined) space.name = fields.name;
    if (fields.executionUserId !== undefined) {
      space.execution_user_id = fields.executionUserId ?? null;
    }
    if (fields.config !== undefined) {
      space.config = structuredClone(fields.config);
      space.config_version += 1;
    }
    if (fields.visibleUserIds !== undefined) {
      this.spaceVisibleUsers.set(id, new Set(fields.visibleUserIds));
    }
    space.updated_at = this.now();
    return this.spaceWithVisibility(space);
  }

  async softDeleteSpaceAndRevokeTokens(tenantId: string, id: string): Promise<SpaceWithVisibilityRow | null> {
    const space = this.spaces.get(id);
    if (!space || space.tenant_id !== tenantId) return null;
    if (this.tenants.get(tenantId)?.default_space_id === id) {
      throw new DefaultSpaceImmutableError('default 空间不能删除');
    }
    space.deleted_at ??= this.now();
    space.updated_at = this.now();
    // MemoryStore 当前没有外部 Token 写入入口；真实 PgStore 在同一事务内完成吊销。
    return this.spaceWithVisibility(space);
  }

  async restoreSpace(tenantId: string, id: string): Promise<SpaceWithVisibilityRow | null> {
    const space = this.spaces.get(id);
    if (!space || space.tenant_id !== tenantId) return null;
    space.deleted_at = null;
    space.updated_at = this.now();
    return this.spaceWithVisibility(space);
  }

  async createUser(input: { tenantId: string; email: string; passwordHash: string; role: TenantUserRole }): Promise<UserRow> {
    const row: UserRow = {
      id: newUserId(),
      tenant_id: input.tenantId,
      email: input.email,
      password_hash: input.passwordHash,
      role: input.role,
      status: 'active',
      created_at: this.now(),
    };
    this.users.set(row.id, row);
    return row;
  }

  async findUserByEmail(tenantId: string, email: string): Promise<UserRow | null> {
    return [...this.users.values()].find((u) => u.tenant_id === tenantId && u.email === email) ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    return this.users.get(id) ?? null;
  }

  async listUsersByTenant(tenantId: string): Promise<UserRow[]> {
    return [...this.users.values()].filter((u) => u.tenant_id === tenantId).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async updateUserRole(id: string, role: TenantUserRole): Promise<UserRow | null> {
    const row = this.users.get(id);
    if (!row) return null;
    row.role = role;
    return row;
  }

  async updateUserStatus(id: string, status: 'active' | 'disabled'): Promise<UserRow | null> {
    const row = this.users.get(id);
    if (!row) return null;
    row.status = status;
    return row;
  }

  async updateUser(
    id: string,
    fields: { email?: string; passwordHash?: string; role?: TenantUserRole; status?: 'active' | 'disabled' },
  ): Promise<UserRow | null> {
    const row = this.users.get(id);
    if (!row) return null;
    if (fields.email !== undefined) row.email = fields.email;
    if (fields.passwordHash !== undefined) row.password_hash = fields.passwordHash;
    if (fields.role !== undefined) row.role = fields.role;
    if (fields.status !== undefined) row.status = fields.status;
    return row;
  }

  async revokeRefreshTokensByUser(userId: string): Promise<void> {
    const revokedAt = this.now();
    for (const token of this.authTokens.values()) {
      if (token.user_id === userId && token.kind === 'refresh' && token.revoked_at == null) token.revoked_at = revokedAt;
    }
  }

  async createAuthToken(input: {
    tenantId: string;
    userId: string;
    kind: 'refresh' | 'api';
    tokenHash: string;
    label?: string | null;
    expiresAt?: string | null;
  }): Promise<AuthTokenRow> {
    const row: AuthTokenRow = {
      id: newAuthTokenId(),
      tenant_id: input.tenantId,
      user_id: input.userId,
      kind: input.kind,
      token_hash: input.tokenHash,
      label: input.label ?? null,
      expires_at: input.expiresAt ?? null,
      revoked_at: null,
      created_at: this.now(),
    };
    this.authTokens.set(row.id, row);
    return row;
  }

  async findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRow | null> {
    return [...this.authTokens.values()].find((t) => t.token_hash === tokenHash) ?? null;
  }

  async revokeAuthToken(id: string): Promise<void> {
    const row = this.authTokens.get(id);
    if (row && !row.revoked_at) row.revoked_at = this.now();
  }

  async listApiTokensByTenant(tenantId: string): Promise<AuthTokenRow[]> {
    return [...this.authTokens.values()]
      .filter((t) => t.tenant_id === tenantId && t.kind === 'api')
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async createSystemAdmin(input: { email: string; passwordHash: string }): Promise<SystemAdminRow> {
    const row: SystemAdminRow = {
      id: newSystemAdminId(),
      email: input.email,
      password_hash: input.passwordHash,
      status: 'active',
      created_at: this.now(),
    };
    this.systemAdmins.set(row.id, row);
    return row;
  }

  async findSystemAdminByEmail(email: string): Promise<SystemAdminRow | null> {
    return [...this.systemAdmins.values()].find((a) => a.email === email) ?? null;
  }

  async findSystemAdminById(id: string): Promise<SystemAdminRow | null> {
    return this.systemAdmins.get(id) ?? null;
  }

  async listSystemAdmins(): Promise<SystemAdminRow[]> {
    return [...this.systemAdmins.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async createSystemAdminToken(input: {
    systemAdminId: string;
    tokenHash: string;
    expiresAt?: string | null;
  }): Promise<SystemAdminTokenRow> {
    const row: SystemAdminTokenRow = {
      id: newSystemAdminTokenId(),
      system_admin_id: input.systemAdminId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt ?? null,
      revoked_at: null,
      created_at: this.now(),
    };
    this.systemAdminTokens.set(row.id, row);
    return row;
  }

  async findSystemAdminTokenByHash(tokenHash: string): Promise<SystemAdminTokenRow | null> {
    return [...this.systemAdminTokens.values()].find((t) => t.token_hash === tokenHash) ?? null;
  }

  async revokeSystemAdminToken(id: string): Promise<void> {
    const row = this.systemAdminTokens.get(id);
    if (row && !row.revoked_at) row.revoked_at = this.now();
  }
}
