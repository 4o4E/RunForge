import type {
  AgentEvent,
  ApiTokenSummary,
  AskUserAnswer,
  CreateApiTokenInput,
  CreateApiTokenResponse,
  CreateUserInput,
  Datasource,
  DatasourceDetailResponse,
  DatasourceInput,
  DatasourceTestResult,
  FileHexPreview,
  FilePreview,
  LlmProviderChatTestResult,
  LlmProviderPingResult,
  LlmProviderProbeResult,
  LlmProviderSettings,
  LlmSettings,
  LlmSettingsOptions,
  McpServerProbeResult,
  McpServerSettings,
  McpSettings,
  McpSettingsOptions,
  PageState,
  PermissionProfile,
  PermissionProfileInput,
  RemoteFileInfo,
  RemoteFileList,
  TenantUserRole,
  ShellCommand,
  ShellCommandAttachment,
  ShellCommandLog,
  ShellCommandScanInput,
  ShellCommandScanResult,
  ShellSession,
  SubagentRun,
  TenantUserSummary,
  Thread,
  ThreadDetailResponse,
  ThreadForkResponse,
  ThreadSearchResponse,
  ThreadUpdateInput,
  ToolSettings,
  ToolSettingsOptions,
  UpdateUserInput,
  WebPushPublicKeyResponse,
  WebPushSubscriptionInput,
  WebPushSubscriptionRecord,
} from '@runforge/contracts';

export type * from '@runforge/contracts';

// access token 只存内存(不落 localStorage)：页面 XSS 时被偷到的窗口更小,
// 代价是刷新页面后需要先用 refreshToken 静默换新的，见 restoreSession()。
// refreshToken 是长期凭证，必须持久化才能跨刷新/关闭标签页存活。
const REFRESH_TOKEN_STORAGE_KEY = 'runforge.refreshToken';
const ACCESS_TOKEN_INVALID_EVENT = 'runforge:access-token-invalid';

let currentAccessToken = '';

export interface FileShareLink {
  path: string;
  expiresAt: string;
  url: string;
  rawUrl: string;
}

export interface FileShareAccess {
  expires: string;
  sig: string;
}

export function readAccessToken(): string {
  return currentAccessToken;
}

function setAccessToken(token: string): void {
  currentAccessToken = token;
}

function readRefreshToken(): string {
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeRefreshToken(token: string): void {
  try {
    window.localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorage 不可用时，页面刷新后需要重新登录。
  }
}

function clearRefreshToken(): void {
  try {
    window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  } catch {
    // 清理失败只影响本地状态，不影响后端鉴权结果。
  }
}

export function clearAccessToken(): void {
  setAccessToken('');
  clearRefreshToken();
}

export function onAccessTokenInvalid(listener: () => void): () => void {
  window.addEventListener(ACCESS_TOKEN_INVALID_EVENT, listener);
  return () => window.removeEventListener(ACCESS_TOKEN_INVALID_EVENT, listener);
}

export async function login(email: string, password: string, tenantId?: string): Promise<TenantUserSummary> {
  const res = await globalThis.fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string; user: TenantUserSummary };
  setAccessToken(body.accessToken);
  writeRefreshToken(body.refreshToken);
  return body.user;
}

/** 给 /admin 这类"共享租户会话、但登录后要求特定角色"的入口用：只有 isAllowedRole
 *  通过时才把 token 落进共享的内存/localStorage 存储。绝不能像 login() 那样先无条件
 *  写入存储、角色不对再 logout()——那样会在角色校验完成前就先用这次登录签发的新
 *  refreshToken 覆盖掉共享 localStorage 里可能属于另一个标签页正常会话的旧值，
 *  即使随后 logout() 也只能撤销新 token，旧值已经从本地丢失，等那个标签页的
 *  access token 过期需要静默刷新时就会失败。 */
export async function loginWithRoleGuard(
  email: string,
  password: string,
  tenantId: string | undefined,
  isAllowedRole: (role: TenantUserRole) => boolean,
): Promise<{ ok: true; user: TenantUserSummary } | { ok: false; user: TenantUserSummary }> {
  const res = await globalThis.fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string; user: TenantUserSummary };
  if (!isAllowedRole(body.user.role)) {
    // 撤销这次登录刚签发的 token——直接用响应里拿到的 refreshToken 调 logout 接口，
    // 不经过 writeRefreshToken/readRefreshToken，共享存储里的旧值全程不受影响。
    try {
      await globalThis.fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: body.refreshToken }),
      });
    } catch {
      // 撤销失败不影响本地判定结果；未持久化的 token 本来就不会被前端用到。
    }
    return { ok: false, user: body.user };
  }
  setAccessToken(body.accessToken);
  writeRefreshToken(body.refreshToken);
  return { ok: true, user: body.user };
}

/** 页面刷新后调用：用持久化的 refreshToken 静默换一个新的 access token。
 *  没有 refreshToken 或刷新失败都返回 false，调用方应展示登录页。 */
export async function restoreSession(): Promise<boolean> {
  const refreshToken = readRefreshToken();
  if (!refreshToken) return false;
  return refreshAccessToken(refreshToken);
}

async function refreshAccessToken(refreshToken: string): Promise<boolean> {
  try {
    const res = await globalThis.fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      clearAccessToken();
      return false;
    }
    const body = (await res.json()) as { accessToken: string };
    setAccessToken(body.accessToken);
    return true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  const refreshToken = readRefreshToken();
  clearAccessToken();
  if (!refreshToken) return;
  try {
    await globalThis.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // 登出请求失败不影响本地已清空的登录态；服务端 refresh token 会自然过期。
  }
}

function authHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  const token = readAccessToken();
  if (token) next.set('Authorization', `Bearer ${token}`);
  return next;
}

export function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(input, { ...init, headers: authHeaders(init.headers) }).then(async (res) => {
    if (res.status !== 401) return res;
    const refreshToken = readRefreshToken();
    if (!refreshToken || !(await refreshAccessToken(refreshToken))) {
      clearAccessToken();
      window.dispatchEvent(new Event(ACCESS_TOKEN_INVALID_EVENT));
      return res;
    }
    // 静默换新成功，用新 access token 重试一次原请求。
    return globalThis.fetch(input, { ...init, headers: authHeaders(init.headers) });
  });
}

function websocketProtocols(): string[] {
  const token = readAccessToken();
  if (!token) return ['runforge-auth'];
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return ['runforge-auth', `runforge-token.${encoded}`];
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

export const listThreads = (options: { archived?: boolean } = {}) => {
  const params = new URLSearchParams();
  if (options.archived) params.set('archived', '1');
  const query = params.toString();
  return authFetch(`/api/threads${query ? `?${query}` : ''}`).then(json<Thread[]>);
};

export const searchThreads = (query: string, limit = 50) => {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return authFetch(`/api/search?${params.toString()}`).then(json<ThreadSearchResponse>);
};

export const getThread = (id: string) =>
  authFetch(`/api/threads/${id}`).then(json<ThreadDetailResponse>);

export const createThread = (title?: string) =>
  authFetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then(json<Thread>);

export const deleteThread = (id: string) =>
  authFetch(`/api/threads/${id}`, { method: 'DELETE' }).then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  });

export const updateThread = (id: string, input: ThreadUpdateInput) =>
  authFetch(`/api/threads/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<Thread>);

export const listRemoteFiles = (path = '.') =>
  authFetch(`/api/files/list?path=${encodeURIComponent(path)}`).then(json<RemoteFileList>);

export const getRemoteFileInfo = () => authFetch('/api/files/info').then(json<RemoteFileInfo>);

export const previewRemoteFile = (path: string, startLine = 1, limit = 200, options: { render?: boolean; share?: FileShareAccess } = {}) => {
  const params = new URLSearchParams({
    path,
    startLine: String(startLine),
    limit: String(limit),
  });
  if (options.render) params.set('render', '1');
  if (options.share) {
    params.set('expires', options.share.expires);
    params.set('sig', options.share.sig);
  }
  return authFetch(`/api/files/preview?${params.toString()}`).then(json<FilePreview>);
};

export const previewRemoteFileHex = (path: string, offset = 0, limit = 4096, options: { share?: FileShareAccess } = {}) => {
  const params = new URLSearchParams({
    path,
    offset: String(offset),
    limit: String(limit),
  });
  if (options.share) {
    params.set('expires', options.share.expires);
    params.set('sig', options.share.sig);
  }
  return authFetch(`/api/files/hex?${params.toString()}`).then(json<FileHexPreview>);
};

export const remoteFileRawUrl = (path: string) => `/api/files/raw?path=${encodeURIComponent(path)}`;

export const remoteFilePdfPreviewUrl = (path: string, share?: FileShareAccess) => {
  const params = new URLSearchParams({ path });
  if (share) {
    params.set('expires', share.expires);
    params.set('sig', share.sig);
  }
  return `/api/files/pdf-preview?${params.toString()}`;
};

export const signedRemoteFileUrl = (path: string, share: FileShareAccess, options: { download?: boolean } = {}) => {
  const params = new URLSearchParams({ path, expires: share.expires, sig: share.sig });
  if (options.download) params.set('download', '1');
  return `/api/files/raw?${params.toString()}`;
};

export const createRemoteFileShareLink = (path: string, ttlSeconds: number) =>
  authFetch('/api/files/share-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, ttlSeconds }),
  }).then(json<FileShareLink>);

export const signedRemoteFileRawUrl = (path: string, ttlSeconds = 24 * 60 * 60) =>
  createRemoteFileShareLink(path, ttlSeconds).then((link) => link.rawUrl);

export const uploadLocalFile = (path: string, contentBase64: string) =>
  authFetch('/api/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, contentBase64 }),
  }).then(json<{ path: string; size: number }>);

export const getToolSettings = () => authFetch('/api/settings/tools').then(json<ToolSettings>);

export const getToolSettingsOptions = () => authFetch('/api/settings/tools/options').then(json<ToolSettingsOptions>);

export const scanShellCommandOptions = (input: ShellCommandScanInput) =>
  authFetch('/api/settings/tools/shell-commands/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<ShellCommandScanResult>);

export const updateToolSettings = (settings: ToolSettings) =>
  authFetch('/api/settings/tools', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then(json<ToolSettings>);

export const getMcpSettings = () => authFetch('/api/settings/mcp').then(json<McpSettings>);

export const getMcpSettingsOptions = () => authFetch('/api/settings/mcp/options').then(json<McpSettingsOptions>);

export const updateMcpSettings = (settings: McpSettings) =>
  authFetch('/api/settings/mcp', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then(json<McpSettings>);

export const probeMcpServer = (server: McpServerSettings) =>
  authFetch('/api/settings/mcp/server/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server }),
  }).then(json<McpServerProbeResult>);

export const getLlmSettings = () => authFetch('/api/settings/llm').then(json<LlmSettings>);

export const getLlmSettingsOptions = () => authFetch('/api/settings/llm/options').then(json<LlmSettingsOptions>);

export const updateLlmSettings = (settings: LlmSettings) =>
  authFetch('/api/settings/llm', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then(json<LlmSettings>);

export const probeLlmProviderModels = (provider: LlmProviderSettings) =>
  authFetch('/api/settings/llm/provider/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  }).then(json<LlmProviderProbeResult>);

export const pingLlmProvider = (provider: LlmProviderSettings) =>
  authFetch('/api/settings/llm/provider/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  }).then(json<LlmProviderPingResult>);

export const testLlmProviderChat = (provider: LlmProviderSettings, model: string, input: string) =>
  authFetch('/api/settings/llm/provider/chat-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, input }),
  }).then(json<LlmProviderChatTestResult>);

export const getPageState = () => authFetch('/api/settings/page-state').then(json<PageState>);

export const updatePageState = (state: PageState) =>
  authFetch('/api/settings/page-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  }).then(json<PageState>);

// --- Tenant admin (/admin 页面用：本租户用户管理 + API token 管理) ---

export const getCurrentUser = () => authFetch('/api/tenants/me').then(json<TenantUserSummary>);

export const listTenantUsers = (tenantId: string) =>
  authFetch(`/api/tenants/${tenantId}/users`).then(json<{ users: TenantUserSummary[] }>);

export const createTenantUser = (tenantId: string, input: CreateUserInput) =>
  authFetch(`/api/tenants/${tenantId}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<TenantUserSummary>);

export const updateTenantUser = (tenantId: string, userId: string, input: UpdateUserInput) =>
  authFetch(`/api/tenants/${tenantId}/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<TenantUserSummary>);

export const listApiTokens = (tenantId: string) =>
  authFetch(`/api/tenants/${tenantId}/tokens`).then(json<{ tokens: ApiTokenSummary[] }>);

export const createApiToken = (tenantId: string, input: CreateApiTokenInput) =>
  authFetch(`/api/tenants/${tenantId}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<CreateApiTokenResponse>);

export const revokeApiToken = (tenantId: string, tokenId: string) =>
  authFetch(`/api/tenants/${tenantId}/tokens/${tokenId}`, { method: 'DELETE' }).then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  });

export const listDatasources = () =>
  authFetch('/api/datasources').then(json<{ datasources: Datasource[] }>);

export const getDatasourceDetail = (id: string) =>
  authFetch(`/api/datasources/${id}`).then(json<DatasourceDetailResponse>);

export const createDatasource = (input: DatasourceInput) =>
  authFetch('/api/datasources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ datasource: Datasource }>);

export const updateDatasource = (id: string, input: DatasourceInput) =>
  authFetch(`/api/datasources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ datasource: Datasource }>);

export const testDatasourceDraft = (input: DatasourceInput) =>
  authFetch('/api/datasources/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<DatasourceTestResult>);

export const testDatasource = (id: string, input: Partial<DatasourceInput> = {}) =>
  authFetch(`/api/datasources/${id}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<DatasourceTestResult>);

export const createPermissionProfile = (datasourceId: string, input: PermissionProfileInput) =>
  authFetch(`/api/datasources/${datasourceId}/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ profile: PermissionProfile }>);

export const createReadonlyProfile = (datasourceId: string) =>
  authFetch(`/api/datasources/${datasourceId}/profiles/readonly-default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).then(json<{ profile: PermissionProfile }>);

export const updatePermissionProfile = (datasourceId: string, profileId: string, input: PermissionProfileInput) =>
  authFetch(`/api/datasources/${datasourceId}/profiles/${profileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<{ profile: PermissionProfile }>);

export const startRun = (threadId: string, input: string, modelRef?: string) =>
  authFetch(`/api/threads/${threadId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, modelRef }),
  }).then(json<{ id: string }>);

export const branchRun = (runId: string, input?: string, modelRef?: string | null) =>
  authFetch(`/api/runs/${runId}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, modelRef }),
  }).then(json<{ id: string; threadId: string; status: string }>);

export const forkThreadFromRun = (runId: string) =>
  authFetch(`/api/runs/${runId}/fork`, { method: 'POST' }).then(json<ThreadForkResponse>);

export const cancelRun = (runId: string) =>
  authFetch(`/api/runs/${runId}/cancel`, { method: 'POST' }).then(json<{ id: string; status: 'canceling' | 'canceled' }>);

export const continueRun = (runId: string) =>
  authFetch(`/api/runs/${runId}/continue`, { method: 'POST' }).then(json<{ id: string; threadId: string; status: 'running' }>);

export const answerRun = (runId: string, answer: AskUserAnswer) =>
  authFetch(`/api/runs/${runId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  }).then(json<{ id: string; threadId: string; status: 'running' }>);

export const listShellSessions = (threadId: string) =>
  authFetch(`/api/shell-sessions?threadId=${encodeURIComponent(threadId)}`).then(json<{ sessions: ShellSession[] }>);

export const listSubagentRuns = (threadId: string) =>
  authFetch(`/api/threads/${threadId}/subagents`).then(json<{ subagents: SubagentRun[] }>);

export const createShellSession = (threadId: string, name?: string) =>
  authFetch('/api/shell-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, name }),
  }).then(json<{ session: ShellSession }>);

export const renameShellSession = (sessionId: string, name: string) =>
  authFetch(`/api/shell-sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(json<{ session: ShellSession | null }>);

export const closeShellSession = (sessionId: string, force = false) =>
  authFetch(`/api/shell-sessions/${sessionId}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  }).then(json<{ session: ShellSession | null }>);

export const runShellCommand = (sessionId: string, command: string) =>
  authFetch(`/api/shell-sessions/${sessionId}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, wait: 'background' }),
  }).then(json<{ command: ShellCommand; timedOutWaiting: boolean; tail: string }>);

export const killShellCommand = (commandId: string, reason = 'user_requested_kill', signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGINT') =>
  authFetch(`/api/shell-commands/${commandId}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, signal }),
  }).then(json<{ command: ShellCommand }>);

export const getShellCommandLogs = (commandId: string, sinceSeq = 0, limit = 200) =>
  authFetch(`/api/shell-commands/${commandId}/logs?sinceSeq=${sinceSeq}&limit=${limit}`).then(json<{ command: ShellCommand; logs: ShellCommandLog[] }>);

export const markShellCommand = (commandId: string) =>
  authFetch(`/api/shell-commands/${commandId}/mark`, { method: 'POST' }).then(json<{ attachment: ShellCommandAttachment }>);

export const getWebPushPublicKey = () =>
  authFetch('/api/notifications/push/public-key').then(json<WebPushPublicKeyResponse>);

export const saveWebPushSubscription = (subscription: WebPushSubscriptionInput) =>
  authFetch('/api/notifications/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  }).then(json<WebPushSubscriptionRecord>);

export const deleteWebPushSubscription = (endpoint: string) =>
  authFetch('/api/notifications/push/subscriptions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  });


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
  const ws = new WebSocket(`${proto}://${location.host}/ws?${params.toString()}`, websocketProtocols());
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
  const ws = new WebSocket(`${proto}://${location.host}/ws?channel=shell&threadId=${encodeURIComponent(threadId)}`, websocketProtocols());
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
