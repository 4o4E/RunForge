// Mirror of the server's AgentEvent union (kept in sync manually for the skeleton).
export type AgentEvent =
  | { type: 'step_start'; step: number }
  | { type: 'reasoning'; step: number; text: string }
  | { type: 'llm_delta'; step: number; text: string }
  | { type: 'tool_call'; step: number; name: string; args: unknown; id: string }
  | { type: 'tool_result'; step: number; id: string; name: string; result: string }
  | { type: 'final'; step: number; output: string }
  | { type: 'error'; step: number; message: string };

export interface Thread {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunWithEvents {
  id: string;
  thread_id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  input: string;
  output: string | null;
  error: string | null;
  created_at: string;
  events: AgentEvent[];
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

export const startRun = (threadId: string, input: string) =>
  fetch(`/api/threads/${threadId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  }).then(json<{ id: string }>);

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
