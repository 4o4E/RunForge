import type { LlmMessage } from '../llm/types.js';

// Context compaction primitives (long-task design §3.3). Pure functions over the
// neutral message list so they're unit-testable without a provider or store.
//
// The cascade, cheapest first:
//   L1 maskOldToolResults  — replace old tool outputs with placeholders (structure kept)
//   L2 slidingWindow       — drop the oldest complete rounds when masking isn't enough
//
// Hard invariant: never break tool_call ↔ tool_result pairing. Masking changes
// content but keeps the message (and its toolCallId); the window only ever cuts on
// a round boundary, never between an assistant's tool calls and their results.

/** Characters that count toward the context size for a single message. */
function msgChars(m: LlmMessage): number {
  let n = m.content?.length ?? 0;
  if (m.toolCalls) n += JSON.stringify(m.toolCalls).length;
  return n;
}

/** Total character size of a message list. */
export function totalChars(messages: LlmMessage[]): number {
  return messages.reduce((sum, m) => sum + msgChars(m), 0);
}

/** Rough token estimate. `tokensPerChar` is calibrated from real usage when
 *  available (see ContextManager); the ~0.25 default is the usual english ratio. */
export function estimateTokens(messages: LlmMessage[], tokensPerChar = 0.25): number {
  return Math.round(totalChars(messages) * tokensPerChar);
}

const MASK_MIN_CHARS = 200; // don't bother masking already-small tool results

/** The placeholder a masked tool result shows the model. Derived purely from the
 *  original length, so the store can recompute it on load without storing it. */
export function maskPlaceholder(originalChars: number): string {
  return `[tool output elided · ${originalChars} chars]`;
}

export interface MaskOptions {
  /** Most-recent messages never masked. */
  keepRecent: number;
}

/**
 * L1 — Observation masking. Replace the content of old, large tool results with a
 * compact placeholder. Keeps the message and its toolCallId so pairing is intact,
 * and keeps the assistant reasoning/decision trace untouched.
 */
export function maskOldToolResults(
  messages: LlmMessage[],
  opts: MaskOptions,
): { messages: LlmMessage[]; masked: number } {
  const cutoff = messages.length - Math.max(0, opts.keepRecent);
  let masked = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m.role !== 'tool' || m.collapsed) return m;
    const chars = m.content?.length ?? 0;
    if (chars < MASK_MIN_CHARS) return m;
    masked += 1;
    return { ...m, content: maskPlaceholder(chars), collapsed: 'masked' as const };
  });
  return { messages: out, masked };
}

/** Leading contiguous system messages — always preserved at the front. */
function leadingSystem(messages: LlmMessage[]): number {
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') i += 1;
  return i;
}

export interface WindowOptions {
  /** Minimum number of most-recent messages to keep. */
  keepRecent: number;
}

/**
 * L2 — Sliding window. When masking still leaves the context over budget, drop the
 * oldest rounds. Always preserved: leading system messages and the first user
 * message (the original request — a cheap goal anchor until the Goal phase lands).
 * The tail is cut only on a safe boundary so no orphan tool result survives.
 */
export function slidingWindow(
  messages: LlmMessage[],
  opts: WindowOptions,
): { messages: LlmMessage[]; dropped: number } {
  const sysEnd = leadingSystem(messages);
  const head = messages.slice(0, sysEnd);
  // First user message after the system prefix, kept as the anchor.
  const firstUserIdx = messages.findIndex((m, i) => i >= sysEnd && m.role === 'user');
  const anchor = firstUserIdx >= 0 ? [messages[firstUserIdx]] : [];

  const desiredStart = Math.max(sysEnd, messages.length - opts.keepRecent);
  // Walk forward to a safe boundary: a 'user' or 'assistant' message. Never start a
  // window on a 'tool' message — its parent assistant would be gone (orphaned result).
  let start = desiredStart;
  while (start < messages.length && messages[start].role === 'tool') start += 1;

  // Nothing meaningful to drop (window already covers everything past the anchor).
  if (start <= firstUserIdx + 1 || start >= messages.length) {
    return { messages, dropped: 0 };
  }

  const tail = messages.slice(start);
  const dropped = start - sysEnd - anchor.length;
  return { messages: [...head, ...anchor, ...tail], dropped: Math.max(0, dropped) };
}
