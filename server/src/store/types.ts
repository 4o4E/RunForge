import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { GoalState } from '../agent/goal.js';
import type { LlmMessage } from '../llm/types.js';
import type { TenantUserRole, WebPushSubscriptionInput } from '@runforge/contracts';

// 多租户改造 Phase 2(docs/multi-tenancy-design.md §5)。Scope 统一放在每个方法的
// 第一个参数,不追加在末尾——很多方法已经有带默认值的可选尾参,追加会打乱参数顺序规则。
// Scope 结构上兼容 TenantScope(多一个 userId 字段无妨),持有 Scope 的调用方可以直接
// 传给只需要 TenantScope 的方法。
//
// Store 层新原则:每个方法自己做过滤,不信任调用方已经在更早的地方校验过归属——本阶段
// 不做 Postgres RLS(见设计文档 §11),Store 层是唯一的强制边界,不能是"调用方自觉"。
export interface Scope {
  tenantId: string;
  userId: string;
}

export interface TenantScope {
  tenantId: string;
}

/** 从 ThreadRow 推导 Scope,给需要"从 runId/threadId 反查 scope"的内部代码
 *  (executor.ts/recovery.ts/api/runtime.ts)统一调用,避免各处重复实现,也避免
 *  各自用 `thread.user_id ?? ''` 悄悄拼出一个谁都匹配不上的空 scope——那样后续
 *  每个 Store 调用都会静默 0 行受影响而不报错(表现为 run 卡住/丢事件,而不是
 *  一个清晰的错误)。`user_id` 为空只发生在用户被删除后(schema.sql 的
 *  `ON DELETE SET NULL`),按设计这类 thread 之后对所有人都不可查,这里直接
 *  抛错,由调用方决定是跳过(recovery.ts 的批量恢复)还是让请求失败
 *  (executor.ts/runtime.ts 的单个 run)。 */
export function scopeForThread(thread: { id: string; tenant_id: string; user_id: string | null }): Scope {
  if (thread.user_id == null) {
    throw new Error(`thread ${thread.id} 没有归属用户(user_id 为空),无法确定执行 scope`);
  }
  return { tenantId: thread.tenant_id, userId: thread.user_id };
}

export interface ThreadRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  title: string | null;
  fallback_title?: string | null;
  active_run_id: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadNoticeRow {
  id: number;
  thread_id: string;
  kind: string;
  message: string;
  title: string | null;
  linked_thread_id: string | null;
  linked_run_id: string | null;
  created_at: string;
}

export interface RunRow {
  id: string;
  thread_id: string;
  parent_run_id: string | null;
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
  tenant_id: string;
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
  tenant_id: string;
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

export interface PushSubscriptionRow {
  endpoint: string;
  tenant_id: string;
  user_id: string | null;
  p256dh: string;
  auth: string;
  expiration_time: string | null;
  user_agent: string | null;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// 多租户改造 Phase 1(docs/multi-tenancy-design.md §4)——身份层的表。
export interface TenantRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  created_at: string;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: TenantUserRole;
  status: 'active' | 'disabled';
  created_at: string;
}

export interface SystemAdminRow {
  id: string;
  email: string;
  password_hash: string;
  status: 'active' | 'disabled';
  created_at: string;
}

export type AuthTokenKind = 'refresh' | 'api';

export interface AuthTokenRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: AuthTokenKind;
  token_hash: string;
  label: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Persistence port. The executor depends on this interface, not on PG directly,
 * so it can be unit-tested with an in-memory implementation.
 */
export interface Store {
  createThread(scope: Scope, title?: string): Promise<ThreadRow>;
  getThread(scope: Scope, id: string): Promise<ThreadRow | null>;
  listThreads(scope: Scope, limit?: number, options?: { archived?: boolean }): Promise<ThreadRow[]>;
  updateThread(
    scope: Scope,
    id: string,
    fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null },
  ): Promise<ThreadRow | null>;
  setThreadTitleIfEmpty(scope: Scope, id: string, title: string): Promise<ThreadRow | null>;
  deleteThread(scope: Scope, id: string): Promise<boolean>;
  searchThreadMessages(scope: Scope, query: string, limit?: number): Promise<ThreadSearchResultRow[]>;
  listThreadNotices(scope: Scope, threadId: string): Promise<ThreadNoticeRow[]>;
  addThreadNotice(scope: Scope, input: {
    threadId: string;
    kind?: string;
    message: string;
    title?: string | null;
    linkedThreadId?: string | null;
    linkedRunId?: string | null;
  }): Promise<ThreadNoticeRow>;
  forkThreadAtRun(scope: Scope, sourceRunId: string): Promise<{ thread: ThreadRow; activeRun: RunRow } | null>;

  createRun(scope: Scope, threadId: string, input: string, options?: { modelRef?: string | null; parentRunId?: string | null }): Promise<RunRow>;
  getRun(scope: Scope, id: string): Promise<RunRow | null>;
  listRuns(scope: Scope, threadId: string): Promise<RunRow[]>;
  /** 跨租户扫描,只给启动期后台任务(recovery.ts)用,禁止在 api/*.ts 路由里调用。 */
  listRunsByStatusUnscoped(statuses: RunStatus[]): Promise<RunRow[]>;
  setRunStatus(scope: Scope, id: string, status: RunStatus, fields?: { output?: string | null; error?: string | null }): Promise<void>;
  /** Persist the run's goal anchor (so it's inspectable and survives a restart). */
  setGoalState(scope: Scope, runId: string, goal: GoalState): Promise<void>;
  /** 不做租户过滤——只给需要"从 runId 反推 scope"的内部代码用:executeRun 自己
   *  (见 executor.ts)、后台任务(recovery.ts)、以及 api/runtime.ts 的
   *  `scopeForRun`(容器脚本走 workload token,没有请求身份可用)。api/runtime.ts
   *  的调用点必须先用 `scopeForThread` 校验、并在铸造/撤销类操作前额外要求真实
   *  租户身份匹配(见 requireRunOwnerIdentity)——不能只凭反推出来的 scope 本身
   *  当作已授权,这个 id 只有在别处被身份校验过才算数。除了这三处,禁止在其余
   *  api/*.ts 路由里直接调用。 */
  getRunUnscoped(id: string): Promise<RunRow | null>;
  /** 同上,给 executeRun/recovery.ts/api/runtime.ts 反推 thread 的 tenant_id/user_id 用。 */
  getThreadUnscoped(id: string): Promise<ThreadRow | null>;

  createStep(scope: Scope, runId: string, idx: number): Promise<StepRow>;
  getLastStepIndex(scope: Scope, runId: string): Promise<number>;
  /** 最后一个 assistant turn 已完整落到 messages 的 step。 */
  getLastCompletedStepIndex(scope: Scope, runId: string): Promise<number>;

  /** Conversation history for a thread, in order, as the compacted LLM-facing view:
   *  masked tool results return their placeholder, 'summarized' rows are omitted. */
  loadThreadMessages(scope: Scope, threadId: string, options?: { runId?: string | null }): Promise<ThreadMessage[]>;
  countRunMessages(scope: Scope, runId: string): Promise<number>;
  /** Append a message; returns its DB id so compaction can reference it later. */
  addMessage(scope: Scope, threadId: string, runId: string, stepId: string | null, msg: LlmMessage): Promise<number>;
  /** Append an L3 summary message and remember which original rows it replaces. */
  addSummaryMessage(
    scope: Scope,
    threadId: string,
    runId: string,
    stepId: string | null,
    msg: LlmMessage,
    summaryOf: number[],
  ): Promise<number>;
  /** Durably mark messages collapsed (context compaction). Originals are retained. */
  markMessagesCollapsed(scope: Scope, ids: number[], kind: 'masked' | 'summarized'): Promise<void>;

  addEvent(scope: Scope, runId: string, stepId: string | null, event: AgentEvent): Promise<void>;
  getEvents(scope: Scope, runId: string): Promise<AgentEvent[]>;

  createSubagentRun(scope: Scope, input: {
    parentRunId: string;
    parentStepId?: string | null;
    workflowId?: string | null;
    stageId?: string | null;
    runtimeProfileId?: string | null;
    taskAssignment: Record<string, unknown>;
    skillNames?: string[];
  }): Promise<SubagentRunRow>;
  finishSubagentRun(
    scope: Scope,
    id: string,
    fields: { status: 'done' | 'error'; output?: string | null; error?: string | null; usage?: Record<string, unknown> | null },
  ): Promise<void>;
  getSubagentRun(scope: Scope, id: string): Promise<SubagentRunRow | null>;
  listSubagentRunsByThread(scope: Scope, threadId: string): Promise<SubagentRunRow[]>;

  createShellSession(scope: Scope, input: {
    threadId: string;
    name: string;
    owner: ShellOwner;
    workspaceRoot: string;
    cwd?: string;
    backend: string;
    configSnapshot?: Record<string, unknown> | null;
  }): Promise<ShellSessionRow>;
  getShellSession(scope: Scope, id: string): Promise<ShellSessionRow | null>;
  listShellSessions(scope: Scope, threadId: string, workspaceRoot?: string): Promise<ShellSessionRow[]>;
  updateShellSession(
    scope: Scope,
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void>;

  createShellCommand(scope: Scope, input: {
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
  getShellCommand(scope: Scope, id: string): Promise<ShellCommandRow | null>;
  listShellCommandsBySession(scope: Scope, sessionId: string, limit?: number): Promise<ShellCommandRow[]>;
  listRunningShellCommandsByRun(scope: Scope, runId: string): Promise<ShellCommandRow[]>;
  /** 跨租户扫描,只给启动期 orphan 标记(shell/manager.ts)用。 */
  listRunningShellCommandsUnscoped(): Promise<ShellCommandRow[]>;
  /** 跨租户更新,只给 markInterruptedCommandsOrphaned 用——启动期一次性扫过所有
   *  租户遗留的 running 命令,这时候不知道也不需要知道每条命令具体属于哪个 scope。 */
  updateShellCommandUnscoped(
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
  updateShellSessionUnscoped(
    id: string,
    fields: Partial<Pick<ShellSessionRow, 'name' | 'status' | 'lease_actor' | 'lease_run_id' | 'cwd' | 'config_snapshot' | 'deleted_at'>>,
  ): Promise<void>;
  updateShellCommand(
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
  ): Promise<void>;
  appendShellCommandLog(scope: Scope, commandId: string, stream: ShellLogStream, chunk: string): Promise<ShellCommandLogRow>;
  getShellCommandLogs(scope: Scope, commandId: string, sinceSeq?: number, limit?: number): Promise<ShellCommandLogRow[]>;
  addShellSessionEvent(scope: Scope, sessionId: string, actor: ShellActor, kind: string, data: unknown): Promise<void>;

  upsertPushSubscription(scope: Scope, input: WebPushSubscriptionInput, userAgent?: string | null): Promise<PushSubscriptionRow>;
  listEnabledPushSubscriptionsByScope(scope: Scope): Promise<PushSubscriptionRow[]>;
  disablePushSubscription(endpoint: string, error?: string | null): Promise<void>;

  // 多租户改造 Phase 1(docs/multi-tenancy-design.md §4)。
  createTenant(input: { id: string; name: string }): Promise<TenantRow>;
  findTenant(id: string): Promise<TenantRow | null>;
  listTenants(): Promise<TenantRow[]>;

  createUser(input: { tenantId: string; email: string; passwordHash: string; role: TenantUserRole }): Promise<UserRow>;
  findUserByEmail(tenantId: string, email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  listUsersByTenant(tenantId: string): Promise<UserRow[]>;
  updateUserRole(id: string, role: TenantUserRole): Promise<UserRow | null>;
  updateUserStatus(id: string, status: 'active' | 'disabled'): Promise<UserRow | null>;

  createAuthToken(input: {
    tenantId: string;
    userId: string;
    kind: AuthTokenKind;
    tokenHash: string;
    label?: string | null;
    expiresAt?: string | null;
  }): Promise<AuthTokenRow>;
  findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRow | null>;
  revokeAuthToken(id: string): Promise<void>;
  listApiTokensByTenant(tenantId: string): Promise<AuthTokenRow[]>;

  createSystemAdmin(input: { email: string; passwordHash: string }): Promise<SystemAdminRow>;
  findSystemAdminByEmail(email: string): Promise<SystemAdminRow | null>;
  listSystemAdmins(): Promise<SystemAdminRow[]>;
}
