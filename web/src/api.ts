// Mirror of the server's AgentEvent union (kept in sync manually for the skeleton).
export type AgentEvent =
  | { type: 'step_start'; step: number }
  | { type: 'reasoning'; step: number; text: string; startedAt?: string; endedAt?: string; durationMs?: number }
  | { type: 'reasoning_timing'; step: number; startedAt: string; endedAt: string; durationMs: number }
  | { type: 'llm_delta'; step: number; text: string }
  | { type: 'tool_call'; step: number; name: string; args: unknown; id: string; startedAt: string }
  | { type: 'tool_result'; step: number; id: string; name: string; result: string; startedAt: string; endedAt: string; durationMs: number }
  | { type: 'a2ui'; step: number; surfaceId: string; message: unknown }
  | { type: 'compaction'; step: number; estBefore: number; estAfter: number; masked: number; summarized?: number; dropped: number; reason?: string }
  | { type: 'user_question'; step: number; question: string; toolCallId?: string; spec?: AskUserSpec }
  | { type: 'user_answer'; step: number; answer: AskUserAnswer }
  | { type: 'progress_stalled'; step: number; reason: string; question?: string }
  | { type: 'recovery'; step: number; message: string }
  | { type: 'final'; step: number; output: string }
  | { type: 'error'; step: number; message: string };

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
  shellAllowCommands: string[];
  network: 'enabled' | 'disabled';
  shellDeny: string[];
  maxOutput: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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
