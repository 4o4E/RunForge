import type { LlmDelta, LlmMessage, LlmResult, LlmTool, Provider } from './types.js';
import {
  providerObservationRepository,
  type ProviderAttemptErrorKind,
  type ProviderObservationRepository,
} from './observability/repository.js';
import {
  providerTraceWriter,
  type ProviderTraceRecord,
  type ProviderTraceWriter,
} from './observability/trace.js';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SECRET_QUERY_KEY = /(api[-_]?key|access[-_]?token|token|secret|signature|sig|^key$)/i;

export type ProviderPurpose = 'agent' | 'title' | 'compaction' | 'subagent' | 'runtime-capability';

export interface ProviderDescriptor {
  provider: string;
  model: string;
  retries: number;
}

export interface ProviderInvocationContext extends ProviderDescriptor {
  tenantId: string;
  spaceId: string;
  threadId: string;
  runId: string;
  stepId: string | null;
  purpose: ProviderPurpose;
}

export interface RunProviderInput {
  provider: Provider;
  context: ProviderInvocationContext;
  messages: LlmMessage[];
  tools: LlmTool[];
  onDelta?: (delta: LlmDelta) => void;
  onRetry?: (input: { attempt: number; message: string }) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

interface AttemptSnapshot {
  id: string | null;
  startedAt: string | null;
  url: string;
  requestBody: unknown;
  httpStatus: number | null;
  providerResponseId: string | null;
  rawResponse: string;
}

class ProviderTransportError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderTransportError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRetry(
  delay: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (!signal) {
    await sleep(delay);
    return true;
  }
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(delay).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    });
  });
}

function jsonBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return value;
  }
}

function responseIdFromRaw(raw: string): string | null {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(raw));
  } catch {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // 原始流仍完整保留；无法解析的事件不影响透传。
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as { id?: unknown; response?: { id?: unknown } };
    if (typeof row.response?.id === 'string') return row.response.id;
    if (typeof row.id === 'string') return row.id;
  }
  return null;
}

function responseId(headers: Headers, raw: string): string | null {
  for (const name of ['x-request-id', 'request-id', 'openai-request-id', 'anthropic-request-id']) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return responseIdFromRaw(raw);
}

function retryable(error: unknown, httpStatus: number | null): boolean {
  if (httpStatus != null && RETRYABLE_STATUS.has(httpStatus)) return true;
  if (error && typeof error === 'object') {
    const row = error as { retryable?: unknown; isRetryable?: unknown; status?: unknown; statusCode?: unknown; name?: unknown };
    if (row.retryable === true || row.isRetryable === true) return true;
    const status = typeof row.statusCode === 'number' ? row.statusCode : row.status;
    if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true;
    if (row.name === 'AbortError') return true;
  }
  return /timed? ?out|(?:fetch|request) failed|network|socket|terminated|econnreset|econnrefused|hang up/i.test(errorMessage(error));
}

function errorKind(error: unknown, httpStatus: number | null): ProviderAttemptErrorKind {
  if (httpStatus != null && httpStatus >= 400) return 'http';
  if (error instanceof ProviderTransportError) return 'transport';
  if (error instanceof SyntaxError || /parse|parsing|invalid json|json.*invalid|unexpected token/i.test(errorMessage(error))) {
    return 'parse';
  }
  if (retryable(error, httpStatus)) return 'transport';
  return 'runtime';
}

function resultForPersistence(result: LlmResult): unknown {
  return {
    content: result.content,
    reasoning: result.reasoning ?? null,
    providerState: result.providerState ?? null,
    toolCalls: result.toolCalls,
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    rawFinishReason: result.rawFinishReason ?? null,
  };
}

function tapResponse(response: Response, snapshot: AttemptSnapshot): Response {
  snapshot.httpStatus = response.status;
  snapshot.providerResponseId = responseId(response.headers, '');
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const tapped = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      snapshot.rawResponse += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    flush() {
      snapshot.rawResponse += decoder.decode();
    },
  }));
  return new Response(tapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function writeTrace(writer: ProviderTraceWriter | null, record: ProviderTraceRecord): Promise<void> {
  if (!writer) return;
  try {
    await writer.write(record);
  } catch (error) {
    console.warn(`[provider-trace] 本地 trace 写入失败：${errorMessage(error)}`);
  }
}

/**
 * RunForge 统一拥有重试和观测状态：adapter 每次只发一个 HTTP 请求；observing fetch 在
 * 请求真正发送前保存最终 wire body，并用透传 TransformStream 聚合上游原始响应。
 */
export class ProviderRunner {
  constructor(
    private readonly repository: ProviderObservationRepository = providerObservationRepository,
    private readonly traceWriter: ProviderTraceWriter | null = process.env.STORE === 'memory' ? null : providerTraceWriter,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly random: () => number = Math.random,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async run(input: RunProviderInput): Promise<LlmResult> {
    const invocationStartedAt = new Date().toISOString();
    const invocationId = await this.repository.createInvocation({
      tenantId: input.context.tenantId,
      spaceId: input.context.spaceId,
      threadId: input.context.threadId,
      runId: input.context.runId,
      stepId: input.context.stepId,
      purpose: input.context.purpose,
      provider: input.context.provider,
      model: input.context.model,
      logicalRequest: {
        messages: input.messages,
        tools: input.tools,
        stream: true,
      },
      startedAt: invocationStartedAt,
    });

    let publishedDelta = false;
    const onDelta: (delta: LlmDelta) => void = input.onDelta
      ? (delta: LlmDelta) => {
          publishedDelta = true;
          input.onDelta!(delta);
        }
      : () => {};

    for (let attempt = 1; attempt <= Math.max(0, input.context.retries) + 1; attempt += 1) {
      const snapshot: AttemptSnapshot = {
        id: null,
        startedAt: null,
        url: '',
        requestBody: {},
        httpStatus: null,
        providerResponseId: null,
        rawResponse: '',
      };

      const observingFetch: typeof globalThis.fetch = async (requestInput, init) => {
        if (snapshot.id) throw new Error('单次 Provider adapter 调用发起了多个 HTTP 请求');
        const request = new Request(requestInput, init);
        snapshot.startedAt = new Date().toISOString();
        snapshot.url = safeUrl(request.url);
        snapshot.requestBody = jsonBody(await request.clone().text());
        snapshot.id = await this.repository.createAttempt({
          invocationId,
          attempt,
          url: snapshot.url,
          requestBody: snapshot.requestBody,
          startedAt: snapshot.startedAt,
        });
        try {
          return tapResponse(await this.fetcher(request), snapshot);
        } catch (error) {
          throw new ProviderTransportError(`请求 ${snapshot.url} 失败：${errorMessage(error)}`, { cause: error });
        }
      };

      try {
        const result = await input.provider.completeStream(
          input.messages,
          input.tools,
          onDelta,
          { fetch: observingFetch, abortSignal: input.abortSignal },
        );
        const endedAt = new Date().toISOString();
        const normalizedResponse = resultForPersistence(result);
        if (snapshot.id) {
          snapshot.providerResponseId ??= responseIdFromRaw(snapshot.rawResponse);
          await this.repository.finishAttempt(snapshot.id, {
            httpStatus: snapshot.httpStatus,
            providerResponseId: snapshot.providerResponseId,
            rawStream: snapshot.rawResponse || null,
            normalizedResponse,
            finishReason: result.finishReason ?? null,
            usage: result.usage ?? null,
            status: 'success',
            errorKind: null,
            error: null,
            endedAt,
          });
          await writeTrace(this.traceWriter, {
            invocationId,
            attemptId: snapshot.id,
            attempt,
            ...input.context,
            url: snapshot.url,
            requestBody: snapshot.requestBody,
            httpStatus: snapshot.httpStatus,
            providerResponseId: snapshot.providerResponseId,
            rawStream: snapshot.rawResponse || null,
            normalizedResponse,
            finishReason: result.finishReason ?? null,
            usage: result.usage ?? null,
            status: 'success',
            errorKind: null,
            error: null,
            retryScheduled: false,
            startedAt: snapshot.startedAt!,
            endedAt,
          });
        }
        await this.repository.finishInvocation(invocationId, {
          status: 'success',
          normalizedResponse,
          error: null,
          endedAt,
        });
        return result;
      } catch (error) {
        const endedAt = new Date().toISOString();
        const message = errorMessage(error);
        const kind = errorKind(error, snapshot.httpStatus);
        const shouldRetry = !input.abortSignal?.aborted
          && !publishedDelta
          && attempt <= input.context.retries
          && retryable(error, snapshot.httpStatus);
        if (snapshot.id) {
          snapshot.providerResponseId ??= responseIdFromRaw(snapshot.rawResponse);
          await this.repository.finishAttempt(snapshot.id, {
            httpStatus: snapshot.httpStatus,
            providerResponseId: snapshot.providerResponseId,
            rawStream: snapshot.rawResponse || null,
            normalizedResponse: null,
            finishReason: null,
            usage: null,
            status: 'error',
            errorKind: kind,
            error: message,
            endedAt,
          });
          await writeTrace(this.traceWriter, {
            invocationId,
            attemptId: snapshot.id,
            attempt,
            ...input.context,
            url: snapshot.url,
            requestBody: snapshot.requestBody,
            httpStatus: snapshot.httpStatus,
            providerResponseId: snapshot.providerResponseId,
            rawStream: snapshot.rawResponse || null,
            normalizedResponse: null,
            finishReason: null,
            usage: null,
            status: 'error',
            errorKind: kind,
            error: message,
            retryScheduled: shouldRetry,
            startedAt: snapshot.startedAt!,
            endedAt,
          });
        }
        if (shouldRetry) {
          await input.onRetry?.({ attempt, message });
          const delay = 800 * 2 ** (attempt - 1) + Math.floor(this.random() * 250);
          console.warn(
            `[provider] invocation ${invocationId} attempt ${attempt} 失败，将在 ${delay}ms 后重试：${message}`,
          );
          if (!await waitForRetry(delay, input.abortSignal, this.sleep)) {
            const abortError = input.abortSignal?.reason instanceof Error
              ? input.abortSignal.reason
              : new Error('Provider 请求已取消');
            await this.repository.finishInvocation(invocationId, {
              status: 'error',
              normalizedResponse: null,
              error: abortError.message,
              endedAt: new Date().toISOString(),
            });
            throw abortError;
          }
          continue;
        }
        await this.repository.finishInvocation(invocationId, {
          status: 'error',
          normalizedResponse: null,
          error: message,
          endedAt,
        });
        throw error;
      }
    }
    throw new Error(`Provider invocation ${invocationId} 没有产生结果`);
  }
}

export const providerRunner = new ProviderRunner();
