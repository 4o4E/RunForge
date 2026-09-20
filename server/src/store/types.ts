import type { AgentEvent, RunStatus } from '../agent/types.js';
import type { GoalState } from '../agent/goal.js';
import type { LlmMessage, LlmTool } from '../llm/types.js';
import type { SpaceMode, TenantUserRole, WebPushSubscriptionInput } from '@runforge/contracts';

/** 只有这三种状态真正释放 thread 执行槽；canceling 仍由当前 executor 收口。 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'done' || status === 'error' || status === 'canceled';
}

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
 *  一个清晰的错误)。当前用户存在关联 thread 时禁止删除；`user_id` 仍允许为空以
 *  兼容旧数据和内部恢复场景。这里直接抛错,由调用方决定是跳过(recovery.ts 的批量恢复)还是让请求失败
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
  space_id: string;
  source_type: 'web' | 'external';
  source_caller_id: string | null;
  source_ref: Record<string, unknown>;
  title: string | null;
  fallback_title?: string | null;
  active_run_id: string | null;
  executing_run_id: string | null;
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
  runtime_capabilities_snapshot: Record<string, unknown> | null;
  space_config_snapshot: Record<string, unknown> | null;
  space_config_version: number | null;
  plugin_lock: Record<string, unknown> | null;
  external_input_open: boolean;
  input_version: number;
  created_at: string;
  updated_at: string;
}

/** 已从持久化注入队列转换成 user message 的外部输入。 */
export interface AppliedRunInput {
  inputId: string;
  version: number;
  content: string;
  messageId: number;
}

export interface StepRow {
  id: string;
  run_id: string;
  idx: number;
  context_snapshot: StepContextSnapshot | null;
  created_at: string;
}

/** 模型调用前固定的协议无关上下文。写入后保持不变，供运行恢复和人工审查使用。 */
export interface StepContextSnapshot {
  messages: LlmMessage[];
  tools: LlmTool[];
  stream: true;
  capturedAt: string;
}

export interface StepContextSummaryRow {
  id: string;
  run_id: string;
  idx: number;
  message_count: number;
  tool_count: number;
  system_prompt: string | null;
  captured_at: string;
}

export interface StoredEvent {
  cursor: number;
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

/** Debug/API 使用的全保真消息行；不应用 masking，也不跳过 summarized 行。 */
export interface RawThreadMessage extends ThreadMessage {
  run_id: string;
  step_id: string | null;
  summaryOf: number[];
  created_at: string;
}

export interface ThreadMessageMetadata {
  id: number;
  run_id: string;
  step_id: string | null;
  role: LlmMessage['role'];
  toolCalls: Array<{ id: string; name: string; argumentChars: number }>;
  toolCallId: string | null;
  collapsed: 'masked' | 'summarized' | null;
  summaryOf: number[];
  contentChars: number;
  /** 用户消息属于对话正文，普通详情接口也返回原文；其他角色只在 Debug 模式返回。 */
  content?: string | null;
  created_at: string;
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
  is_bootstrap: boolean;
  default_space_id: string | null;
  created_at: string;
}

export interface SpaceRow {
  id: string;
  tenant_id: string;
  mode: SpaceMode;
  name: string;
  execution_user_id: string | null;
  config: Record<string, unknown>;
  config_version: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpaceWithVisibilityRow extends SpaceRow {
  visible_user_ids: string[];
}

export interface CreateSpaceRecordInput {
  tenantId: string;
  mode: SpaceMode;
  name: string;
  executionUserId: string | null;
  config: Record<string, unknown>;
  createdByUserId: string | null;
  visibleUserIds: string[];
}

export interface UpdateSpaceRecordInput {
  name?: string;
  executionUserId?: string | null;
  config?: Record<string, unknown>;
  visibleUserIds?: string[];
}

export class DeleteConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeleteConflictError';
  }
}

export interface DeleteResourceResult {
  artifactStorageKeys: string[];
}

export class SpaceConfigChangedError extends Error {
  readonly code = 'SPACE_CONFIG_CHANGED';

  constructor() {
    super('空间配置已更新，请按最新配置重试');
    this.name = 'SpaceConfigChangedError';
  }
}

export interface CreateRunOptions {
  modelRef?: string | null;
  parentRunId?: string | null;
  runtimeCapabilitiesSnapshot?: Record<string, unknown> | null;
  spaceConfigSnapshot?: Record<string, unknown>;
  pluginLock?: object;
  expectedSpaceConfigVersion?: number;
}

export interface TenantConfigTemplateEntry {
  key: string;
  value: unknown;
}

export interface CreateTenantWithOwnerInput {
  id: string;
  name: string;
  isBootstrap?: boolean;
  ownerEmail: string;
  ownerPasswordHash: string;
  settingsTemplate: readonly TenantConfigTemplateEntry[];
  defaultSpaceConfig?: Record<string, unknown>;
}

export interface TenantProvisioningResult {
  tenant: TenantRow;
  owner: UserRow;
  defaultSpace: SpaceRow;
}

/** 同一 thread 已有非终态 run。API 用该结构化错误返回 409 和当前 run 信息。 */
export class RunActiveError extends Error {
  readonly code = 'RUN_ACTIVE';

  constructor(
    readonly currentRunId: string,
    readonly currentStatus: RunStatus,
  ) {
    super(`thread 已有活动 run ${currentRunId}（${currentStatus}）`);
    this.name = 'RunActiveError';
  }
}

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: TenantUserRole;
  status: 'active' | 'disabled';
  is_bootstrap: boolean;
  created_at: string;
}

export interface SystemAdminRow {
  id: string;
  email: string;
  password_hash: string;
  status: 'active' | 'disabled';
  is_bootstrap: boolean;
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

// 系统管理员的 refresh token,不能复用 AuthTokenRow——那张表的 tenant_id/user_id
// 是 NOT NULL,系统管理员两边都不在(Prisma schema 的 system_admin_tokens)。
export interface SystemAdminTokenRow {
  id: string;
  system_admin_id: string;
  token_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Persistence port. The executor depends on this interface, not on PG directly,
 * so it can be unit-tested with an in-memory implementation.
 */
export interface Store {
  createThread(scope: Scope, title?: string, options?: { spaceId?: string }): Promise<ThreadRow>;
  getThread(scope: Scope, id: string): Promise<ThreadRow | null>;
  /** Web 只读入口使用的空间视图查询。调用方必须先通过 SpaceAccessService 得到
   * 可见空间列表；Store 再把 tenant、thread 和这些 space 一起放进查询条件，
   * 避免为了查看 external thread 冒充 execution user。 */
  getThreadInSpaces(tenantId: string, id: string, spaceIds: string[]): Promise<ThreadRow | null>;
  listThreads(scope: Scope, limit?: number, options?: { archived?: boolean; spaceIds?: string[] }): Promise<ThreadRow[]>;
  /** Web 空间只返回当前用户自己的会话；external 空间返回该空间的外部会话。
   * 两组空间 ID 都必须来自 SpaceAccessService 的可见空间结果。 */
  listThreadsForViewer(
    scope: Scope,
    limit?: number,
    options?: { archived?: boolean; webSpaceIds?: string[]; externalSpaceIds?: string[] },
  ): Promise<ThreadRow[]>;
  updateThread(
    scope: Scope,
    id: string,
    fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null },
  ): Promise<ThreadRow | null>;
  setThreadTitleIfEmpty(scope: Scope, id: string, title: string): Promise<ThreadRow | null>;
  deleteThread(scope: Scope, id: string): Promise<DeleteResourceResult | null>;
  searchThreadMessages(scope: Scope, query: string, limit?: number, options?: { spaceIds?: string[] }): Promise<ThreadSearchResultRow[]>;
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

  createRun(scope: Scope, threadId: string, input: string, options?: CreateRunOptions): Promise<RunRow>;
  /** 只有 pending/running 能进入执行；与 canceling 竞争时返回 false，避免启动覆盖取消。 */
  beginRunExecution(scope: Scope, id: string): Promise<boolean>;
  getRun(scope: Scope, id: string): Promise<RunRow | null>;
  listRuns(scope: Scope, threadId: string): Promise<RunRow[]>;
  /** 跨租户扫描,只给启动期后台任务(recovery.ts)用,禁止在 api/*.ts 路由里调用。 */
  listRunsByStatusUnscoped(statuses: RunStatus[]): Promise<RunRow[]>;
  /** 永久删除资源前批量取消目标 thread 的全部非终态 run，并释放执行槽。 */
  cancelRunsForDeletion(threadIds: string[]): Promise<RunRow[]>;
  setRunStatus(scope: Scope, id: string, status: RunStatus, fields?: { output?: string | null; error?: string | null }): Promise<void>;
  /** 在 provider 调用前，把已接纳的 next_step 输入按版本顺序原子转换成 user message。 */
  applyPendingRunInputs(scope: Scope, id: string): Promise<AppliedRunInput[]>;
  /**
   * 正常结束 external run 前先关闭输入接纳，再原子吸收已经排队的输入。
   * 有输入时会重新打开接纳，由 executor 继续下一 step；无输入时保持关闭以阻止迟到请求。
   */
  closeExternalInputAndApplyPending(
    scope: Scope,
    id: string,
  ): Promise<{ closed: boolean; inputs: AppliedRunInput[] }>;
  /** 从指定旧状态原子切回 pending 并重新占用 thread 执行槽；回答消息如有也在
   * 同一事务落库，避免恢复到 pending 后丢失输入。状态已变化时返回 null。 */
  resumeRun(
    scope: Scope,
    id: string,
    expectedStatuses: RunStatus[],
    fields?: { output?: string | null; error?: string | null; userMessageContent?: string },
  ): Promise<RunRow | null>;
  /** Persist the run's goal anchor (so it's inspectable and survives a restart). */
  setGoalState(scope: Scope, runId: string, goal: GoalState): Promise<void>;
  /** 固定本次 run 可使用的运行时能力，后续恢复不得重新读取租户当前配置。 */
  setRuntimeCapabilitiesSnapshot(
    scope: Scope,
    runId: string,
    snapshot: object,
  ): Promise<void>;
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
  /** 永久删除协调器使用；始终要求 tenant 作用域，不能作为普通读取接口。 */
  listThreadsForDeletion(tenantId: string, spaceId?: string): Promise<ThreadRow[]>;

  createStep(scope: Scope, runId: string, idx: number): Promise<StepRow>;
  /** 在 Provider 调用前固定该 step 的最终上下文；同一 step 禁止覆盖。 */
  saveStepContext(scope: Scope, stepId: string, snapshot: StepContextSnapshot): Promise<void>;
  /** 读取当前分支中已经固定的 step 上下文摘要，不加载完整消息 JSON。 */
  listStepContextSummaries(scope: Scope, threadId: string, options?: { runId?: string | null }): Promise<StepContextSummaryRow[]>;
  /** 按 step 读取当前分支中的单个完整上下文。 */
  getStepContext(scope: Scope, threadId: string, stepId: string, options?: { runId?: string | null }): Promise<StepRow | null>;
  getLastStepIndex(scope: Scope, runId: string): Promise<number>;
  /** 最后一个 assistant turn 已完整落到 messages 的 step。 */
  getLastCompletedStepIndex(scope: Scope, runId: string): Promise<number>;

  /** Conversation history for a thread, in order, as the compacted LLM-facing view:
   *  masked tool results return their placeholder, 'summarized' rows are omitted. */
  loadThreadMessages(scope: Scope, threadId: string, options?: { runId?: string | null }): Promise<ThreadMessage[]>;
  /** 普通 UI 只取已压缩消息的轻量元数据，不读取原始大载荷。 */
  loadThreadMessageMetadata(scope: Scope, threadId: string, options?: { runId?: string | null }): Promise<ThreadMessageMetadata[]>;
  /** 返回当前分支的原始持久化消息，只允许受身份校验的 Debug 接口调用。 */
  loadRawThreadMessages(scope: Scope, threadId: string, options?: { runId?: string | null }): Promise<RawThreadMessage[]>;
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
  /** 按数据库 events.id 增量读取，用于可重连的外部事件流。 */
  getEventsAfterCursor(scope: Scope, runId: string, cursor: number): Promise<StoredEvent[]>;

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
  /** 永久删除资源前终止没有活动进程句柄的 queued/running 命令。 */
  cancelShellCommandsForDeletion(threadIds: string[]): Promise<void>;
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
  /** tenant、首个 owner、初始租户设置和 default space 必须在同一事务内创建。 */
  createTenantWithOwner(input: CreateTenantWithOwnerInput): Promise<TenantProvisioningResult>;
  findTenant(id: string): Promise<TenantRow | null>;
  findBootstrapTenant(): Promise<TenantRow | null>;
  migrateBootstrapTenantId(currentId: string, nextId: string): Promise<TenantRow>;
  listTenants(): Promise<TenantRow[]>;
  updateTenantStatus(id: string, status: 'active' | 'suspended'): Promise<TenantRow | null>;
  deleteTenant(id: string): Promise<DeleteResourceResult | null>;
  getDefaultSpace(tenantId: string): Promise<SpaceRow | null>;
  listSpaces(tenantId: string): Promise<SpaceWithVisibilityRow[]>;
  findSpace(tenantId: string, id: string): Promise<SpaceWithVisibilityRow | null>;
  createSpace(input: CreateSpaceRecordInput): Promise<SpaceWithVisibilityRow>;
  updateSpace(tenantId: string, id: string, fields: UpdateSpaceRecordInput): Promise<SpaceWithVisibilityRow | null>;
  deleteSpace(tenantId: string, id: string, replacementDefaultSpaceId?: string): Promise<DeleteResourceResult | null>;

  createUser(input: { tenantId: string; email: string; passwordHash: string; role: TenantUserRole; isBootstrap?: boolean }): Promise<UserRow>;
  findUserByEmail(tenantId: string, email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  listUsersByTenant(tenantId: string): Promise<UserRow[]>;
  updateUser(
    id: string,
    fields: { email?: string; passwordHash?: string; role?: TenantUserRole; status?: 'active' | 'disabled' },
  ): Promise<UserRow | null>;
  markBootstrapUser(id: string): Promise<UserRow>;
  deleteUser(tenantId: string, id: string): Promise<boolean>;
  revokeRefreshTokensByUser(userId: string): Promise<void>;

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

  createSystemAdmin(input: { email: string; passwordHash: string; isBootstrap?: boolean }): Promise<SystemAdminRow>;
  findSystemAdminByEmail(email: string): Promise<SystemAdminRow | null>;
  findSystemAdminById(id: string): Promise<SystemAdminRow | null>;
  listSystemAdmins(): Promise<SystemAdminRow[]>;
  markBootstrapSystemAdmin(id: string): Promise<SystemAdminRow>;
  deleteSystemAdmin(id: string): Promise<boolean>;

  createSystemAdminToken(input: {
    systemAdminId: string;
    tokenHash: string;
    expiresAt?: string | null;
  }): Promise<SystemAdminTokenRow>;
  findSystemAdminTokenByHash(tokenHash: string): Promise<SystemAdminTokenRow | null>;
  revokeSystemAdminToken(id: string): Promise<void>;
}
