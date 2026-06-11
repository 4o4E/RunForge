// Convert persisted run history (loaded over REST) into AI SDK `UIMessage`s, so
// useChat can restore a thread on selection. Each run becomes a user message
// (the input) plus an assistant message whose parts are folded from the run's
// events — mirroring how the live stream produces parts (Phase 3).

import type { UIMessage } from 'ai';
import type { RunWithEvents } from './api';
import { toUiEvent } from './transport/legacy';
import type { UiEvent } from './transport/types';

type Part = UIMessage['parts'][number];

/** Fold an ordered `UiEvent` list into linear message parts (text / reasoning /
 *  tool). Contiguous text and reasoning deltas coalesce; tool input/output merge
 *  by call id. */
export function foldUiEventsToParts(events: UiEvent[]): Part[] {
  const parts: Part[] = [];
  const toolById = new Map<string, Record<string, unknown>>();
  const a2uiBySurface = new Map<string, number>();
  let textBuf = '';
  let reasonBuf = '';
  let reasonStep: number | null = null;
  let reasonTiming: { startedAt?: string; endedAt?: string; durationMs?: number } = {};

  const flushText = () => {
    if (textBuf) {
      parts.push({ type: 'text', text: textBuf, state: 'done' });
      textBuf = '';
    }
  };
  const flushReason = () => {
    if (reasonBuf) {
      const id = `r-${reasonStep ?? parts.length}`;
      parts.push({ type: 'reasoning', id, text: reasonBuf, state: 'done', step: reasonStep, ...reasonTiming } as unknown as Part);
      if (reasonTiming.startedAt && reasonTiming.endedAt) {
        parts.push({
          type: 'data-reasoning-timing',
          id,
          data: { step: reasonStep, ...reasonTiming },
        } as unknown as Part);
      }
      reasonBuf = '';
      reasonStep = null;
      reasonTiming = {};
    }
  };

  for (const e of events) {
    switch (e.kind) {
      case 'reasoning':
        flushText();
        reasonStep = e.step;
        if (e.startedAt || e.endedAt || e.durationMs !== undefined) {
          reasonTiming = { startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs };
        }
        reasonBuf += e.delta;
        break;
      case 'reasoning_timing':
        reasonTiming = { startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs };
        if (!reasonBuf) {
          parts.push({
            type: 'data-reasoning-timing',
            id: `r-${e.step}`,
            data: { step: e.step, ...reasonTiming },
          } as unknown as Part);
        }
        break;
      case 'text':
        flushReason();
        textBuf += e.delta;
        break;
      case 'tool': {
        flushReason();
        flushText();
        let p = toolById.get(e.id);
        if (!p) {
          p = {
            type: 'dynamic-tool',
            toolName: e.name,
            toolCallId: e.id,
            state: 'input-available',
            input: e.input,
            step: e.step,
            startedAt: e.startedAt,
          };
          toolById.set(e.id, p);
          parts.push(p as unknown as Part);
        }
        if (e.input !== undefined) p.input = e.input;
        if (e.startedAt) p.startedAt = e.startedAt;
        if (e.output !== undefined) {
          p.output = e.output;
          p.state = 'output-available';
          p.endedAt = e.endedAt;
          p.durationMs = e.durationMs;
          if (e.startedAt && e.endedAt) {
            parts.push({
              type: 'data-tool-timing',
              id: e.id,
              data: { id: e.id, step: e.step, startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs },
            } as unknown as Part);
          }
        }
        break;
      }
      case 'final':
        flushReason();
        if (textBuf) flushText();
        else if (e.output) parts.push({ type: 'text', text: e.output, state: 'done' });
        break;
      case 'error':
        flushReason();
        flushText();
        parts.push({ type: 'text', text: `⚠️ ${e.message}`, state: 'done' });
        break;
      case 'a2ui':
        flushReason();
        flushText();
        if (a2uiBySurface.has(e.surfaceId)) {
          parts[a2uiBySurface.get(e.surfaceId) as number] = { type: 'data-a2ui', id: e.surfaceId, data: e.message } as unknown as Part;
        } else {
          a2uiBySurface.set(e.surfaceId, parts.length);
          parts.push({ type: 'data-a2ui', id: e.surfaceId, data: e.message } as unknown as Part);
        }
        break;
      case 'step_start':
        break;
    }
  }
  flushReason();
  flushText();
  return parts;
}

/** Map persisted runs (oldest→newest) to a flat UIMessage list. */
export function runsToUiMessages(runs: RunWithEvents[]): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const run of runs) {
    messages.push({ id: `${run.id}:u`, role: 'user', parts: [{ type: 'text', text: run.input }] });
    const parts = foldUiEventsToParts(
      run.events.map(toUiEvent).filter((e): e is UiEvent => e !== null),
    );
    if (parts.length) {
      parts.unshift({ type: 'data-run-id', id: run.id, data: { runId: run.id } } as unknown as Part);
      messages.push({ id: `${run.id}:a`, role: 'assistant', parts });
    }
  }
  return messages;
}
