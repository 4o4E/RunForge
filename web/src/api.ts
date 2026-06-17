import type {
  AgentEvent,
  AskUserAnswer,
  Datasource,
  DatasourceDetailResponse,
  DatasourceInput,
  DatasourceTestResult,
  FilePreview,
  LlmProviderChatTestResult,
  LlmProviderPingResult,
  LlmProviderProbeResult,
  LlmProviderSettings,
  LlmSettings,
  LlmSettingsOptions,
  PageState,
  PermissionProfile,
  PermissionProfileInput,
  RemoteFileInfo,
  RemoteFileList,
  ShellCommand,
  ShellCommandAttachment,
  ShellCommandLog,
  ShellCommandScanInput,
  ShellCommandScanResult,
  ShellSession,
  SubagentRun,
  Thread,
  ThreadDetailResponse,
  ThreadSearchResponse,
  ToolSettings,
  ToolSettingsOptions,
} from '@my-agent/contracts';

export type * from '@my-agent/contracts';

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

export const searchThreads = (query: string, limit = 50) => {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return fetch(`/api/search?${params.toString()}`).then(json<ThreadSearchResponse>);
};

export const getThread = (id: string) =>
  fetch(`/api/threads/${id}`).then(json<ThreadDetailResponse>);

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

export const getToolSettingsOptions = () => fetch('/api/settings/tools/options').then(json<ToolSettingsOptions>);

export const scanShellCommandOptions = (input: ShellCommandScanInput) =>
  fetch('/api/settings/tools/shell-commands/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<ShellCommandScanResult>);

export const updateToolSettings = (settings: ToolSettings) =>
  fetch('/api/settings/tools', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then(json<ToolSettings>);

export const getLlmSettings = () => fetch('/api/settings/llm').then(json<LlmSettings>);

export const getLlmSettingsOptions = () => fetch('/api/settings/llm/options').then(json<LlmSettingsOptions>);

export const updateLlmSettings = (settings: LlmSettings) =>
  fetch('/api/settings/llm', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then(json<LlmSettings>);

export const probeLlmProviderModels = (provider: LlmProviderSettings) =>
  fetch('/api/settings/llm/provider/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  }).then(json<LlmProviderProbeResult>);

export const pingLlmProvider = (provider: LlmProviderSettings) =>
  fetch('/api/settings/llm/provider/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  }).then(json<LlmProviderPingResult>);

export const testLlmProviderChat = (provider: LlmProviderSettings, model: string, input: string) =>
  fetch('/api/settings/llm/provider/chat-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, input }),
  }).then(json<LlmProviderChatTestResult>);

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
  fetch(`/api/datasources/${id}`).then(json<DatasourceDetailResponse>);

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

export const startRun = (threadId: string, input: string, modelRef?: string) =>
  fetch(`/api/threads/${threadId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, modelRef }),
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

export const listSubagentRuns = (threadId: string) =>
  fetch(`/api/threads/${threadId}/subagents`).then(json<{ subagents: SubagentRun[] }>);

export const createShellSession = (threadId: string, name?: string) =>
  fetch('/api/shell-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, name }),
  }).then(json<{ session: ShellSession }>);

export const renameShellSession = (sessionId: string, name: string) =>
  fetch(`/api/shell-sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(json<{ session: ShellSession | null }>);

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

export const markShellCommand = (commandId: string) =>
  fetch(`/api/shell-commands/${commandId}/mark`, { method: 'POST' }).then(json<{ attachment: ShellCommandAttachment }>);


/** 通过 WebSocket 订阅 run 的实时事件流。 */
export function subscribeRun(
  runId: string,
  onEvent: (e: AgentEvent) => void,
  onClose?: () => void,
  options: { replay?: 'all' | 'none' } = {},
): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ runId });
  if (options.replay) params.set('replay', options.replay);
  const ws = new WebSocket(`${proto}://${location.host}/ws?${params.toString()}`);
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
