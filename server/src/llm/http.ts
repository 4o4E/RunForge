export interface PostJsonOptions {
  timeoutMs: number;
  /** number of RETRIES on transient failure (total attempts = retries + 1) */
  retries?: number;
  /** base backoff in ms; grows exponentially with jitter */
  backoffMs?: number;
}

// Transient HTTP statuses worth retrying (rate limit + gateway/server errors).
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new HttpError(`HTTP ${res.status}: ${text}`, res.status, RETRYABLE_STATUS.has(res.status));
    }
    return await res.json();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Timeouts and network errors are transient → retryable.
    const msg = (err as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message;
    throw new HttpError(`request to ${url} failed: ${msg}`, null, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST and read a Server-Sent Events stream, invoking `onData` for each `data:`
 * payload (the raw string after `data: `). Resolves when the stream ends.
 * No retry — streaming failures surface to the caller (which may fall back).
 */
export async function streamPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  onData: (data: string) => void,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`stream HTTP ${res.status}: ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by newlines; emit each complete `data:` line.
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) onData(line.slice(5).trim());
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** POST JSON with a hard timeout and automatic retry/backoff on transient failures. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostJsonOptions,
): Promise<unknown> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 800;

  let lastErr: HttpError | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt(url, headers, body, opts.timeoutMs);
    } catch (err) {
      lastErr = err as HttpError;
      if (!lastErr.retryable || i === retries) break;
      const delay = backoffMs * 2 ** i + Math.floor(Math.random() * 250);
      console.warn(`[llm] transient failure (${lastErr.message.slice(0, 80)}); retry ${i + 1}/${retries} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`${lastErr?.message ?? 'request failed'} (after ${retries + 1} attempt(s))`);
}
