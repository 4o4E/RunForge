// 前端手动同步后端 AgentEvent 联合类型。
export type PlanStatus = 'todo' | 'doing' | 'done' | 'failed';

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export interface GoalState {
  intent: string;
  phase?: 'working' | 'reporting' | 'completed';
  plan: PlanItem[];
  decisions: string[];
  next: string;
}

export type AgentEvent =
  | { type: 'step_start'; step: number }
  | ({ type: 'stream_stats'; step: number } & StreamStats)
  | { type: 'usage_update'; step: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; estContextTokens?: number; contextBudget?: number }
  | { type: 'reasoning'; step: number; text: string; startedAt?: string; endedAt?: string; durationMs?: number }
  | { type: 'reasoning_timing'; step: number; startedAt: string; endedAt: string; durationMs: number }
  | { type: 'llm_delta'; step: number; text: string }
  | { type: 'tool_call'; step: number; name: string; args: unknown; id: string; startedAt: string }
  | { type: 'tool_result'; step: number; id: string; name: string; result: string; startedAt: string; endedAt: string; durationMs: number }
  | { type: 'plan_update'; step: number; goal: GoalState }
  | { type: 'compaction'; step: number; estBefore: number; estAfter: number; masked: number; summarized?: number; dropped: number; reason?: string }
  | { type: 'shell_session_opened'; step: number; sessionId: string; backend: string; workspaceRoot: string }
  | { type: 'shell_session_closed'; step: number; sessionId: string; reason?: string }
  | { type: 'shell_lease_changed'; step: number; sessionId: string; actor: 'agent' | 'user' | 'system' | null; runId?: string | null }
  | { type: 'shell_command_started'; step: number; sessionId: string; commandId: string; command: string; waitMode: 'foreground' | 'background'; startedAt: string }
  | { type: 'shell_command_output'; step: number; sessionId: string; commandId: string; stream: 'stdout' | 'stderr' | 'system'; seq: number; text: string }
  | { type: 'shell_command_timeout'; step: number; sessionId: string; commandId: string; soft: boolean; runtimeMs: number; message: string }
  | { type: 'shell_command_attention'; step: number; sessionId: string; commandId: string; attention: string; message: string }
  | { type: 'shell_command_finished'; step: number; sessionId: string; commandId: string; status: 'succeeded' | 'failed' | 'killed' | 'timed_out' | 'orphaned'; exitCode?: number | null; signal?: string | null; durationMs?: number }
  | { type: 'shell_command_killed'; step: number; sessionId: string; commandId: string; signal: string; reason?: string }
  | { type: 'user_question'; step: number; question: string; toolCallId?: string; spec?: AskUserSpec }
  | { type: 'user_answer'; step: number; answer: AskUserAnswer }
  | { type: 'user_cancel'; step: number; reason?: string }
  | { type: 'progress_stalled'; step: number; reason: string; question?: string }
  | { type: 'recovery'; step: number; message: string }
  | { type: 'final'; step: number; output: string }
  | { type: 'error'; step: number; message: string };

export type StreamStage =
  | 'llm_waiting'
  | 'reasoning'
  | 'output'
  | 'tool_call'
  | 'tool_running'
  | 'tool_result'
  | 'done'
  | 'error';

export interface StreamStats {
  stage: StreamStage;
  updatedAt: string;
  activeTool?: { id: string; name: string };
  totals: {
    outputChars: number;
    reasoningChars: number;
    toolInputChars: number;
    toolOutputChars: number;
    totalChars: number;
  };
  rate: {
    charsPerSecond: number;
    history: number[];
  };
}

export interface Thread {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export type AskUserMode = 'single' | 'multiple' | 'text';

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  required?: boolean;
}

export interface AskUserSpec {
  question: string;
  mode: AskUserMode;
  options: AskUserOption[];
  allowCustom: boolean;
  required: boolean;
}

export interface AskUserAnswer {
  mode: AskUserMode;
  selected: AskUserOption[];
  customOptions: string[];
  text: string;
  note: string;
  usedRecommended: boolean;
}

export interface RunWithEvents {
  id: string;
  thread_id: string;
  status: 'pending' | 'running' | 'waiting_for_user' | 'done' | 'error' | 'canceling' | 'canceled';
  input: string;
  output: string | null;
  error: string | null;
  goal_state?: GoalState | null;
  created_at: string;
  events: AgentEvent[];
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  updatedAt: string;
}

export interface RemoteFileList {
  path: string;
  parent: string | null;
  entries: RemoteFileEntry[];
}

export interface FilePreview {
  path: string;
  size: number;
  mode: 'full' | 'chunk';
  startLine: number;
  lines: string[];
  totalLines: number;
  nextLine: number | null;
  hasMore: boolean;
}

export interface RemoteFileInfo {
  workspaceRoot: string;
  rootPath: string;
}

export interface ToolSettings {
  sandbox: 'off' | 'enforce';
  sandboxBackend: 'auto' | 'none' | 'bwrap';
  workspaceRoot: string;
  allow: string[];
  deny: string[];
  shellEnabled: boolean;
  shellUseHostPath: boolean;
  shellAllowCommands: string[];
  network: 'enabled' | 'disabled';
  shellDeny: string[];
  maxOutput: number;
}

export type PageState = Record<string, unknown>;

export type DatasourceType = 'postgres' | 'mysql' | 'mongodb' | 'hive';
export type DatasourceStatus = 'active' | 'disabled';
export type PermissionMode = 'readonly' | 'limited_write' | 'custom';
export type AccountStatus = 'idle' | 'leased' | 'cooling_down' | 'disabled';
export type LeaseStatus = 'leased' | 'released' | 'expired' | 'failed';

export interface Datasource {
  id: string;
  name: string;
  type: DatasourceType;
  status: DatasourceStatus;
  connection: Record<string, unknown>;
  pool_config: Record<string, unknown>;
  hasAdminConfig: boolean;
  created_at: string;
  updated_at: string;
}

export interface PermissionProfile {
  id: string;
  datasource_id: string;
  name: string;
  mode: PermissionMode;
  template_role: string | null;
  grants: Record<string, unknown>;
  pool_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DatasourceAccount {
  id: string;
  datasource_id: string;
  profile_id: string;
  username: string;
  status: AccountStatus;
  current_run_id: string | null;
  leased_until: string | null;
  last_lease_at: string | null;
  last_rotated_at: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface DatasourceLease {
  id: string;
  account_id: string;
  datasource_id: string;
  profile_id: string;
  run_id: string;
  status: LeaseStatus;
  leased_at: string;
  expires_at: string;
  released_at: string | null;
  error: string | null;
}

export interface DatasourceInput {
  name: string;
  type: DatasourceType;
  status?: DatasourceStatus;
  connection: Record<string, unknown>;
  adminConfig?: Record<string, unknown>;
  poolConfig?: Record<string, unknown>;
}

export interface PermissionProfileInput {
  name: string;
  mode: PermissionMode;
  templateRole?: string;
  grants?: Record<string, unknown>;
  poolConfig?: Record<string, unknown>;
}

export interface DatasourceColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  position: number;
}

export interface DatasourceTableInfo {
  schema: string;
  name: string;
  type: string;
  columns: DatasourceColumnInfo[];
}

export interface DatasourceTestResult {
  ok: true;
  type: DatasourceType;
  database?: string;
  tableCount: number;
  tables: DatasourceTableInfo[];
}

export type ShellActor = 'agent' | 'user' | 'system';
export type ShellSessionStatus = 'opening' | 'idle' | 'busy' | 'attached_by_user' | 'closing' | 'closed' | 'orphaned';
export type ShellCommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed' | 'timed_out' | 'orphaned';

export interface ShellSession {
  id: string;
  thread_id: string;
  workspace_root: string;
  cwd: string;
  backend: string;
  status: ShellSessionStatus;
  lease_actor: ShellActor | null;
  lease_run_id: string | null;
  pinned: boolean;
  idle_expires_at: string | null;
  created_at: string;
  updated_at: string;
  commands?: ShellCommand[];
}

export interface ShellCommand {
  id: string;
  session_id: string;
  run_id: string | null;
  step_id: string | null;
  actor: ShellActor;
  command: string;
  cwd: string;
  wait_mode: 'foreground' | 'background';
  status: ShellCommandStatus;
  attention: string | null;
  exit_code: number | null;
  signal: string | null;
  output_bytes: string | number;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

export interface ShellCommandLog {
  id: number;
  command_id: string;
  seq: number;
  stream: 'stdout' | 'stderr' | 'system';
  chunk: string;
  created_at: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { error?: unknown };
      detail = typeof body.error === 'string' ? body.error : '';
    } catch {
      detail = '';
    }
    throw new Error(detail ? `${res.status} ${detail}` : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const listThreads = () => fetch('/api/threads').then(json<Thread[]>);

export const getThread = (id: string) =>
  fetch(`/api/threads/${id}`).then(json<{ thread: Thread; runs: RunWithEvents[] }>);

export const createThread = (title?: string) =>
  fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then(json<Thread>);

export const deleteThread = (id: string) =>
  fetch(`/api/threads/${id}`, { method: 'DELETE' }).then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  });

export const listRemoteFiles = (path = '.') =>
  fetch(`/api/files/list?path=${encodeURIComponent(path)}`).then(json<RemoteFileList>);

export const getRemoteFileInfo = () => fetch('/api/files/info').then(json<RemoteFileInfo>);

export const previewRemoteFile = (path: string, startLine = 1, limit = 200, options: { render?: boolean } = {}) => {
  const params = new URLSearchParams({
    path,
    startLine: String(startLine),
    limit: String(limit),
  });
  if (options.render) params.set('render', '1');
  return fetch(`/api/files/preview?${params.toString()}`).then(json<FilePreview>);
};

export const uploadLocalFile = (path: string, contentBase64: string) =>
  fetch('/api/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, contentBase64 }),
  }).then(json<{ path: string; size: number }>);

export const getToolSettings = () => fetch('/api/settings/tools').then(json<ToolSettings>);

export const updateToolSettings = (settings: ToolSettings) =>
  fetch('/api/settings/tools', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then(json<ToolSettings>);

export const getPageState = () => fetch('/api/settings/page-state').then(json<PageState>);

export const updatePageState = (state: PageState) =>
  fetch('/api/settings/page-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  }).then(json<PageState>);

export const listDatasources = () =>
  fetch('/api/datasources').then(json<{ datasources: Datasource[] }>);

export const getDatasourceDetail = (id: string) =>
  fetch(`/api/datasources/${id}`).then(json<{
    datasource: Datasource;
    profiles: PermissionProfile[];
    accounts: DatasourceAccount[];
    leases: DatasourceLease[];
  }>);

export const createDatasource = (input: DatasourceInput) =>
  fetch('/api/datasources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ datasource: Datasource }>);

export const updateDatasource = (id: string, input: DatasourceInput) =>
  fetch(`/api/datasources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ datasource: Datasource }>);

export const testDatasourceDraft = (input: DatasourceInput) =>
  fetch('/api/datasources/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<DatasourceTestResult>);

export const testDatasource = (id: string, input: Partial<DatasourceInput> = {}) =>
  fetch(`/api/datasources/${id}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<DatasourceTestResult>);

export const createPermissionProfile = (datasourceId: string, input: PermissionProfileInput) =>
  fetch(`/api/datasources/${datasourceId}/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ profile: PermissionProfile }>);

export const createReadonlyProfile = (datasourceId: string) =>
  fetch(`/api/datasources/${datasourceId}/profiles/readonly-default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).then(json<{ profile: PermissionProfile }>);

export const updatePermissionProfile = (datasourceId: string, profileId: string, input: PermissionProfileInput) =>
  fetch(`/api/datasources/${datasourceId}/profiles/${profileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ profile: PermissionProfile }>);

export const startRun = (threadId: string, input: string) =>
  fetch(`/api/threads/${threadId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  }).then(json<{ id: string }>);

export const cancelRun = (runId: string) =>
  fetch(`/api/runs/${runId}/cancel`, { method: 'POST' }).then(json<{ id: string; status: 'canceling' | 'canceled' }>);

export const answerRun = (runId: string, answer: AskUserAnswer) =>
  fetch(`/api/runs/${runId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  }).then(json<{ id: string; threadId: string; status: 'running' }>);

export const listShellSessions = (threadId: string) =>
  fetch(`/api/shell-sessions?threadId=${encodeURIComponent(threadId)}`).then(json<{ sessions: ShellSession[] }>);

export const createShellSession = (threadId: string, pinned = true) =>
  fetch('/api/shell-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, pinned }),
  }).then(json<{ session: ShellSession }>);

export const closeShellSession = (sessionId: string, force = false) =>
  fetch(`/api/shell-sessions/${sessionId}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  }).then(json<{ session: ShellSession | null }>);

export const runShellCommand = (sessionId: string, command: string) =>
  fetch(`/api/shell-sessions/${sessionId}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, wait: 'background' }),
  }).then(json<{ command: ShellCommand; timedOutWaiting: boolean; tail: string }>);

export const killShellCommand = (commandId: string, reason = 'user_requested_kill', signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGINT') =>
  fetch(`/api/shell-commands/${commandId}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, signal }),
  }).then(json<{ command: ShellCommand }>);

export const getShellCommandLogs = (commandId: string, sinceSeq = 0, limit = 200) =>
  fetch(`/api/shell-commands/${commandId}/logs?sinceSeq=${sinceSeq}&limit=${limit}`).then(json<{ command: ShellCommand; logs: ShellCommandLog[] }>);

export const takeoverShellSession = (sessionId: string) =>
  fetch(`/api/shell-sessions/${sessionId}/takeover`, { method: 'POST' }).then(json<{ session: ShellSession }>);

export const releaseShellSession = (sessionId: string) =>
  fetch(`/api/shell-sessions/${sessionId}/release`, { method: 'POST' }).then(json<{ session: ShellSession }>);

/** 通过 WebSocket 订阅 run 的实时事件流。 */
export function subscribeRun(
  runId: string,
  onEvent: (e: AgentEvent) => void,
  onClose?: () => void,
): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?runId=${runId}`);
  ws.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as AgentEvent);
    } catch {
      /* 忽略格式错误的帧 */
    }
  };
  ws.onclose = () => onClose?.();
  return () => ws.close();
}

/** 订阅当前 thread 的 shell 事件，右侧 Shell 面板用它触发实时刷新。 */
export function subscribeShell(
  threadId: string,
  onEvent: (event: AgentEvent) => void,
  onClose?: () => void,
): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?channel=shell&threadId=${encodeURIComponent(threadId)}`);
  ws.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as AgentEvent);
    } catch {
      /* 忽略异常帧。 */
    }
  };
  ws.onclose = () => onClose?.();
  return () => ws.close();
}
