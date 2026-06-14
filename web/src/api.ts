// Mirror of the server's AgentEvent union (kept in sync manually for the skeleton).
export type PlanStatus = 'todo' | 'doing' | 'done' | 'failed';

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export interface GoalState {
  intent: string;
  plan: PlanItem[];
  decisions: string[];
  next: string;
}

export type AgentEvent =
  | { type: 'step_start'; step: number }
  | ({ type: 'stream_stats'; step: number } & StreamStats)
  | { type: 'reasoning'; step: number; text: string; startedAt?: string; endedAt?: string; durationMs?: number }
  | { type: 'reasoning_timing'; step: number; startedAt: string; endedAt: string; durationMs: number }
  | { type: 'llm_delta'; step: number; text: string }
  | { type: 'tool_call'; step: number; name: string; args: unknown; id: string; startedAt: string }
  | { type: 'tool_result'; step: number; id: string; name: string; result: string; startedAt: string; endedAt: string; durationMs: number }
  | { type: 'plan_update'; step: number; goal: GoalState }
  | { type: 'compaction'; step: number; estBefore: number; estAfter: number; masked: number; summarized?: number; dropped: number; reason?: string }
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

export const previewRemoteFile = (path: string, startLine = 1, limit = 200) =>
  fetch(`/api/files/preview?path=${encodeURIComponent(path)}&startLine=${startLine}&limit=${limit}`).then(json<FilePreview>);

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

/** Subscribe to a run's live event stream over WebSocket. */
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
      /* ignore malformed frame */
    }
  };
  ws.onclose = () => onClose?.();
  return () => ws.close();
}
