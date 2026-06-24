import type { LlmMessage, LlmToolCall } from '../llm/types.js';

// Context compaction primitives (long-task design §3.3). Pure functions over the
// neutral message list so they're unit-testable without a provider or store.
//
// The cascade, cheapest first:
//   L1 maskOldToolResults  — replace old tool outputs with placeholders (structure kept)
//   L1 maskOldAssistantToolCalls — replace old large tool-call args with summaries
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
const MASK_HEAD_CHARS = 140; // how much of the original to keep as a recall hint
const TOOL_ARGS_MASK_MIN_CHARS = 1000; // small args are useful enough to keep verbatim
const TOOL_ARGS_HEAD_CHARS = 240;

/** The placeholder a masked tool result shows the model: a short head hint plus an
 *  elision marker. Derived purely from the original content, so the store recomputes
 *  the exact same string on load (the original is retained — nothing is stored). The
 *  head lets the model recall what that call found instead of re-running it. */
export function maskPlaceholder(original: string): string {
  if (original.length <= MASK_HEAD_CHARS) return original;
  const head = original.slice(0, MASK_HEAD_CHARS).replace(/\s+/g, ' ').trimEnd();
  return `${head}\n…[+${original.length - head.length} chars elided]`;
}

function maskedToolCallArguments(call: LlmToolCall): string {
  const base = {
    context_elided: true,
    not_executable: true,
    tool_name: call.name,
    original_chars: call.arguments.length,
    instruction:
      'Historical tool-call arguments were compacted. Do not copy this object into a new tool call; rebuild complete arguments if the tool is needed.',
    instruction_zh: '这是压缩后的历史工具调用参数。不要把这个对象复制成新的工具调用；如果仍需调用工具，请重新构造完整参数。',
  };

  const preview = call.arguments.slice(0, TOOL_ARGS_HEAD_CHARS).replace(/\s+/g, ' ').trimEnd();
  return JSON.stringify({
    ...base,
    non_executable_preview: preview,
  });
}

/** 压缩旧 assistant tool call 的大参数。保留 id/name，避免破坏 provider 需要的
 *  tool_call ↔ tool_result 结构；参数替换成明确不可执行的历史占位，避免模型复用。 */
export function maskToolCallArguments(calls: LlmToolCall[]): { calls: LlmToolCall[]; changed: boolean } {
  let changed = false;
  const out = calls.map((call) => {
    if (call.arguments.length < TOOL_ARGS_MASK_MIN_CHARS) return call;
    changed = true;
    return {
      ...call,
      arguments: maskedToolCallArguments(call),
    };
  });
  return { calls: out, changed };
}

export interface MaskOptions {
  /** Most-recent messages never masked. */
  keepRecent: number;
  /** These tool calls carry display payloads; mask large args even in recent turns. */
  forceToolNames?: string[];
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
    return { ...m, content: maskPlaceholder(m.content ?? ''), collapsed: 'masked' as const };
  });
  return { messages: out, masked };
}

/** L1 — Tool-call argument masking. Older assistant messages can carry huge
 *  arguments. The result message remains paired by
 *  call id, so old arguments can be summarized without losing conversation shape. */
export function maskOldAssistantToolCalls(
  messages: LlmMessage[],
  opts: MaskOptions,
): { messages: LlmMessage[]; masked: number } {
  const cutoff = messages.length - Math.max(0, opts.keepRecent);
  const force = new Set(opts.forceToolNames ?? []);
  let masked = 0;
  const out = messages.map((m, i) => {
    if (m.role !== 'assistant' || m.collapsed || !m.toolCalls?.length) return m;
    const shouldMask = i < cutoff || m.toolCalls.some((call) => force.has(call.name));
    if (!shouldMask) return m;
    const result = maskToolCallArguments(m.toolCalls);
    if (!result.changed) return m;
    masked += 1;
    return { ...m, toolCalls: result.calls, collapsed: 'masked' as const };
  });
  return { messages: out, masked };
}

/** Leading contiguous system messages — always preserved at the front. */
function leadingSystem(messages: LlmMessage[]): number {
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') i += 1;
  return i;
}

function toolCallIds(message: LlmMessage): string[] {
  return message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : [];
}

function summaryEndBeforeSplitToolRound(messages: LlmMessage[], protectedEnd: number, initialEnd: number): number {
  let end = initialEnd;
  while (end > protectedEnd) {
    const parentIndexByCallId = new Map<string, number>();
    for (let i = protectedEnd; i < end; i += 1) {
      for (const id of toolCallIds(messages[i])) parentIndexByCallId.set(id, i);
    }

    let nextEnd = end;
    for (let i = end; i < messages.length; i += 1) {
      const message = messages[i];
      if (message.role !== 'tool' || !message.toolCallId) continue;
      const parentIndex = parentIndexByCallId.get(message.toolCallId);
      if (parentIndex != null) nextEnd = Math.min(nextEnd, parentIndex);
    }
    if (nextEnd === end) return end;
    end = nextEnd;
  }
  return end;
}

export interface WindowOptions {
  /** Minimum number of most-recent messages to keep. */
  keepRecent: number;
}

export interface SummaryCandidate {
  start: number;
  end: number;
  messages: LlmMessage[];
}

/** 找到可做 L3 摘要的旧消息区间：保留前导 system、首个用户目标和最近窗口。 */
export function summaryCandidate(messages: LlmMessage[], opts: WindowOptions): SummaryCandidate | null {
  const sysEnd = leadingSystem(messages);
  const firstUserIdx = messages.findIndex((m, i) => i >= sysEnd && m.role === 'user');
  const protectedEnd = firstUserIdx >= 0 ? firstUserIdx + 1 : sysEnd;
  let end = Math.max(protectedEnd, messages.length - Math.max(0, opts.keepRecent));

  // 摘要边界不能拆开 assistant tool_call 与后续 tool_result 的配对。
  end = summaryEndBeforeSplitToolRound(messages, protectedEnd, end);
  while (end > protectedEnd && messages[end - 1]?.role === 'tool') end -= 1;
  while (end > protectedEnd && messages[end - 1]?.role === 'assistant' && messages[end - 1]?.toolCalls?.length) end -= 1;

  if (end <= protectedEnd) return null;
  const slice = messages.slice(protectedEnd, end);
  if (!slice.some((m) => m.role !== 'system')) return null;
  return { start: protectedEnd, end, messages: slice };
}

export function renderSummaryPrompt(messages: LlmMessage[], goal: string): LlmMessage[] {
  const transcript = messages
    .map((m, i) => {
      const head = `[${i + 1}] ${m.role}${m.toolCallId ? ` toolCallId=${m.toolCallId}` : ''}`;
      const calls = m.toolCalls?.length ? `\ntoolCalls=${JSON.stringify(m.toolCalls)}` : '';
      return `${head}${calls}\n${m.content ?? ''}`;
    })
    .join('\n\n---\n\n');

  return [
    {
      role: 'system',
      content:
        '请为后续 LLM 调用总结较早的 agent 上下文。必须保留：意图、计划、关键决策、下一步、关键文件路径、命令、错误信息和已完成动作。要求简洁、准确、不要编造。',
    },
    {
      role: 'user',
      content: `当前目标锚点：\n${goal}\n\n需要摘要的旧上下文：\n${transcript}`,
    },
  ];
}

export function summaryMessage(summary: string): LlmMessage {
  return {
    role: 'system',
    content: `L3 锚定摘要：\n${summary.trim()}`,
    collapsed: 'summarized',
  };
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
