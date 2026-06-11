// LegacyTransport (Phase 0): wraps the existing REST (`startRun`) + WebSocket
// (`subscribeRun`) wire protocol behind the `UiTransport` interface, mapping the
// server's `AgentEvent` frames onto the normalized `UiEvent` model. This is the
// only place that knows about the legacy protocol; everything above it depends
// solely on `UiEvent`.

import { startRun, subscribeRun, type AgentEvent } from '../api';
import type { UiEvent, UiTransport, UserInput } from './types';

/** Map one wire `AgentEvent` onto the normalized `UiEvent` model, or `null` for
 *  events with nothing to render (e.g. `compaction` telemetry) and any future
 *  server event this client doesn't model yet. Returning `null` instead of
 *  `undefined` keeps an unknown frame from crashing the fold/stream — callers
 *  filter it out. Exported so historical runs loaded over REST normalize the
 *  same way as the live stream. */
export function toUiEvent(e: AgentEvent): UiEvent | null {
  switch (e.type) {
    case 'step_start':
      return { kind: 'step_start', step: e.step };
    case 'reasoning':
      return {
        kind: 'reasoning',
        step: e.step,
        delta: e.text,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        durationMs: e.durationMs,
      };
    case 'reasoning_timing':
      return {
        kind: 'reasoning_timing',
        step: e.step,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        durationMs: e.durationMs,
      };
    case 'llm_delta':
      return { kind: 'text', step: e.step, delta: e.text };
    case 'tool_call':
      return { kind: 'tool', step: e.step, id: e.id, name: e.name, input: e.args, startedAt: e.startedAt };
    case 'tool_result':
      return {
        kind: 'tool',
        step: e.step,
        id: e.id,
        name: e.name,
        output: e.result,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        durationMs: e.durationMs,
      };
    case 'a2ui':
      return { kind: 'a2ui', step: e.step, surfaceId: e.surfaceId, message: e.message };
    case 'final':
      return { kind: 'final', step: e.step, output: e.output };
    case 'error':
      return { kind: 'error', step: e.step, message: e.message };
    default:
      // `compaction` and any unmodeled future event: no UI representation.
      return null;
  }
}

export const legacyTransport: UiTransport = {
  async send(threadId, input: UserInput) {
    const { id } = await startRun(threadId, input.text);
    return { runId: id };
  },
  subscribe(runId, onEvent, onClose) {
    return subscribeRun(
      runId,
      (e) => {
        const ui = toUiEvent(e);
        if (ui) onEvent(ui);
      },
      onClose,
    );
  },
};
