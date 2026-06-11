// Transport boundary (Phase 0): the UI layer depends only on `UiEvent` and the
// `UiTransport` interface — never on the concrete wire protocol (WS frames, SSE,
// or a future AG-UI / A2UI part stream). Swapping the transport (LegacyTransport →
// AiSdkTransport → AgUiTransport) must not touch any rendering code.

/** A user-submitted turn. Kept as an object so future fields (attachments, etc.)
 *  do not change the transport signature. */
export interface UserInput {
  text: string;
}

/**
 * Normalized UI event the rendering layer consumes. Independent of the wire
 * format; transports map their native frames onto this union.
 *
 * `step` is preserved (the engine is multi-step and the UI groups by step). A
 * `tool` event may carry `input` (on the call) and/or `output` (on the result);
 * the renderer merges the two by `id`. The `a2ui` variant is reserved for
 * Phase 5 (declarative UI) and is part of the contract now so the boundary need
 * not change later.
 */
export type UiEvent =
  | { kind: 'step_start'; step: number }
  | { kind: 'reasoning'; step: number; delta: string; startedAt?: string; endedAt?: string; durationMs?: number }
  | { kind: 'reasoning_timing'; step: number; startedAt: string; endedAt: string; durationMs: number }
  | { kind: 'text'; step: number; delta: string }
  | { kind: 'tool'; step: number; id: string; name: string; input?: unknown; output?: unknown; startedAt?: string; endedAt?: string; durationMs?: number }
  | { kind: 'a2ui'; step: number; surfaceId: string; message: unknown }
  | { kind: 'final'; step: number; output: string }
  | { kind: 'error'; step: number; message: string };

/**
 * Abstraction over "how a run is started and streamed". Upper layers call
 * `send` to begin a run and `subscribe` to receive `UiEvent`s; they never see
 * the underlying REST/WS calls.
 */
export interface UiTransport {
  /** Start a run for `input` on `threadId`; resolves with the new run id. */
  send(threadId: string, input: UserInput): Promise<{ runId: string }>;
  /** Stream live `UiEvent`s for a run. Returns an unsubscribe function. */
  subscribe(runId: string, onEvent: (e: UiEvent) => void, onClose?: () => void): () => void;
}
