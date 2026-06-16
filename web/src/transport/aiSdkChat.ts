// AI SDK ChatTransport that bridges our existing backend (Phase 3).
//
// Instead of switching the backend to an HTTP UI-message-stream, we reuse the
// `UiTransport` abstraction from Phase 0: this transport wraps `legacyTransport`
// (REST start-run + WS event stream) and converts our normalized `UiEvent`s into
// the AI SDK `UIMessageChunk` stream that `useChat` consumes. The backend
// (executor / WS / PostgreSQL) is untouched, so persistence and thread recovery
// keep working — only the frontend state/rendering moves onto useChat + parts.

import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { createThread, type Thread } from '../api';
import { legacyTransport } from './legacy';
import type { UiEvent } from './types';

/** Mutable handle so App and the transport agree on the active thread id, which
 *  may be created lazily on the first send. */
export interface ChatThreadHandle {
  getThreadId(): string | null;
  setThreadId(id: string): void;
  onThreadCreated(thread: Thread): void;
  setActiveRunId(id: string | null): void;
}

/** Extract the plain text of a user UIMessage (its text parts joined). */
function userText(message: UIMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}

/** Subscribe shape (matches `legacyTransport.subscribe`); injectable for tests. */
export type SubscribeFn = (
  runId: string,
  onEvent: (e: UiEvent) => void,
  onClose?: () => void,
) => () => void;

/**
 * Convert a live `UiEvent` subscription for `runId` into a `UIMessageChunk`
 * ReadableStream. Streams text/reasoning as start/delta/end runs (one run per
 * step), and tool calls as input/output-available parts.
 */
export function uiEventStreamToChunks(
  runId: string,
  abortSignal?: AbortSignal,
  subscribe: SubscribeFn = legacyTransport.subscribe,
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      let closed = false;
      let openText: string | null = null;
      let openReason: string | null = null;
      let deltaFrame: number | null = null;
      let deltaTimer: ReturnType<typeof setTimeout> | null = null;
      const pendingTextDeltas = new Map<string, string>();
      const pendingReasonDeltas = new Map<string, string>();

      const safe = (chunk: UIMessageChunk) => {
        if (!closed) controller.enqueue(chunk);
      };
      const flushBufferedDeltas = () => {
        deltaFrame = null;
        deltaTimer = null;
        for (const [id, delta] of pendingTextDeltas) {
          safe({ type: 'text-delta', id, delta });
        }
        pendingTextDeltas.clear();
        for (const [id, delta] of pendingReasonDeltas) {
          safe({ type: 'reasoning-delta', id, delta });
        }
        pendingReasonDeltas.clear();
      };
      const scheduleBufferedDeltas = () => {
        if (deltaFrame !== null || deltaTimer !== null) return;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          deltaFrame = window.requestAnimationFrame(flushBufferedDeltas);
        } else {
          deltaTimer = setTimeout(flushBufferedDeltas, 16);
        }
      };
      const flushBufferedDeltasNow = () => {
        if (deltaFrame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(deltaFrame);
        }
        if (deltaTimer !== null) clearTimeout(deltaTimer);
        if (pendingTextDeltas.size > 0 || pendingReasonDeltas.size > 0) {
          flushBufferedDeltas();
        } else {
          deltaFrame = null;
          deltaTimer = null;
        }
      };
      const safeTextDelta = (id: string, delta: string) => {
        pendingTextDeltas.set(id, `${pendingTextDeltas.get(id) ?? ''}${delta}`);
        scheduleBufferedDeltas();
      };
      const safeReasoningDelta = (id: string, delta: string) => {
        pendingReasonDeltas.set(id, `${pendingReasonDeltas.get(id) ?? ''}${delta}`);
        scheduleBufferedDeltas();
      };
      const closeText = () => {
        if (openText) {
          flushBufferedDeltasNow();
          safe({ type: 'text-end', id: openText });
          openText = null;
        }
      };
      const closeReason = () => {
        if (openReason) {
          flushBufferedDeltasNow();
          safe({ type: 'reasoning-end', id: openReason });
          openReason = null;
        }
      };

      safe({ type: 'start' });
      safe({ type: 'data-run-id', id: runId, data: { runId } } as unknown as UIMessageChunk);

      const onEvent = (e: UiEvent) => {
        switch (e.kind) {
          case 'step_start':
            break;
          case 'stream_stats':
            safe({ type: 'data-stream-stats', id: `stats-${runId}`, data: e.stats } as unknown as UIMessageChunk);
            break;
          case 'usage_update':
            safe({ type: 'data-usage-update', id: `usage-${e.step}`, data: e.usage } as unknown as UIMessageChunk);
            break;
          case 'notice': {
            closeReason();
            const id = `t-${e.step}`;
            if (openText !== id) {
              closeText();
              safe({ type: 'text-start', id });
              openText = id;
            }
            safeTextDelta(id, e.message);
            break;
          }
          case 'ask_user_question':
            closeText();
            closeReason();
            safe({ type: 'data-ask-user-question', id: `ask-${e.step}`, data: e.spec } as unknown as UIMessageChunk);
            break;
          case 'ask_user_answer':
            closeText();
            closeReason();
            safe({ type: 'data-ask-user-answer', id: `answer-${e.step}`, data: e.answer } as unknown as UIMessageChunk);
            break;
          case 'ask_user_cancel':
            closeText();
            closeReason();
            safe({ type: 'data-ask-user-cancel', id: `cancel-${e.step}`, data: { reason: e.reason } } as unknown as UIMessageChunk);
            break;
          case 'reasoning': {
            closeText();
            const id = `r-${e.step}`;
            if (openReason !== id) {
              closeReason();
              safe({ type: 'reasoning-start', id });
              openReason = id;
            }
            safeReasoningDelta(id, e.delta);
            if (e.startedAt && e.endedAt) {
              flushBufferedDeltasNow();
              safe({
                type: 'data-reasoning-timing',
                id,
                data: { step: e.step, startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs },
              } as unknown as UIMessageChunk);
            }
            break;
          }
          case 'reasoning_timing': {
            const id = `r-${e.step}`;
            closeReason();
            safe({
              type: 'data-reasoning-timing',
              id,
              data: { step: e.step, startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs },
            } as unknown as UIMessageChunk);
            break;
          }
          case 'text': {
            closeReason();
            const id = `t-${e.step}`;
            if (openText !== id) {
              closeText();
              safe({ type: 'text-start', id });
              openText = id;
            }
            safeTextDelta(id, e.delta);
            break;
          }
          case 'tool': {
            closeText();
            closeReason();
            if (e.input !== undefined) {
              safe({ type: 'tool-input-available', toolCallId: e.id, toolName: e.name, input: e.input });
            }
            if (e.output !== undefined) {
              safe({ type: 'tool-output-available', toolCallId: e.id, output: e.output });
            }
            if (e.startedAt && e.endedAt) {
              safe({
                type: 'data-tool-timing',
                id: e.id,
                data: { id: e.id, step: e.step, startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs },
              } as unknown as UIMessageChunk);
            }
            break;
          }
          case 'plan_update':
            closeText();
            closeReason();
            safe({ type: 'data-plan-state', id: `plan-${e.step}`, data: e.goal } as unknown as UIMessageChunk);
            break;
          case 'final': {
            // If this step produced no streamed text, surface the final output as
            // a text part; otherwise it was already streamed via 'text' deltas.
            if (!openText && e.output) {
              const id = `t-${e.step}`;
              safe({ type: 'text-start', id });
              safeTextDelta(id, e.output);
              openText = id;
            }
            closeText();
            closeReason();
            safe({ type: 'data-final-output', id: `final-${e.step}`, data: { step: e.step, output: e.output } } as unknown as UIMessageChunk);
            break;
          }
          case 'error': {
            closeText();
            closeReason();
            safe({ type: 'error', errorText: e.message });
            break;
          }
        }
      };

      const finish = () => {
        if (closed) return;
        flushBufferedDeltasNow();
        closeText();
        closeReason();
        safe({ type: 'finish' });
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const unsubscribe = subscribe(runId, onEvent, finish);

      abortSignal?.addEventListener('abort', finish, { once: true });
    },
  });
}

/** A `ChatTransport` backed by the legacy REST+WS pipeline. */
export function createAiSdkChatTransport(handle: ChatThreadHandle): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const text = userText(messages[messages.length - 1]);

      let threadId = handle.getThreadId();
      if (!threadId) {
        const thread = await createThread(text.slice(0, 40) || '新会话');
        threadId = thread.id;
        handle.setThreadId(thread.id);
        handle.onThreadCreated(thread);
      }

      const { runId } = await legacyTransport.send(threadId, { text });
      handle.setActiveRunId(runId);
      return uiEventStreamToChunks(runId, abortSignal);
    },

    // No mid-stream resume for the WS pipeline; recovery is via PG history on load.
    async reconnectToStream() {
      return null;
    },
  };
}
