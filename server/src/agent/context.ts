import type { LlmMessage, LlmUsage } from '../llm/types.js';
import type { ThreadMessage } from '../store/types.js';
import { config } from '../config.js';
import { estimateTokens, maskOldToolResults, slidingWindow, totalChars } from './compaction.js';

const SYSTEM_PROMPT = `You are my-agent, a general-purpose autonomous assistant.

You operate in a loop: think, optionally call tools, observe results, and continue
until the task is complete. Then give a concise final answer.

Guidelines:
- Prefer tools to act on the world (run commands, read/write files, search the web).
- Call one or more tools when they help; otherwise answer directly.
- When you have enough information, stop calling tools and write the final answer.
- Be concise. State assumptions you made instead of asking when possible.
- For structured results the user would benefit from seeing as a rich UI (tables,
  key/value summaries, cards), call the render_ui tool with an A2UI component
  description in addition to your text answer.`;

/** What a compaction pass did, surfaced for events/telemetry. */
export interface CompactionInfo {
  estBefore: number;
  estAfter: number;
  masked: number;
  dropped: number;
}

export interface CompactionResult {
  info: CompactionInfo;
  /** DB ids newly masked this pass — the executor persists these so the decision
   *  survives a restart. (Window drops are in-memory only and never persisted.) */
  collapsedIds: number[];
}

/** A message in the working set plus the DB row it came from (null = not yet
 *  persisted or not maskable, e.g. the system prompt). */
interface WorkingMessage {
  msg: LlmMessage;
  dbId: number | null;
}

/**
 * Holds the working message list for a single run and keeps it under the context
 * budget. A fresh system prompt, the prior thread history (multi-turn memory, already
 * compacted by the store), and the new user input. Before each LLM call the executor
 * calls `maybeCompact()` so a long task never blows past the model window. Masking
 * decisions are reported back so they can be persisted (long-task design §3.3, §4).
 */
export class ContextManager {
  private items: WorkingMessage[] = [];
  /** Tokens-per-char ratio, calibrated from real provider usage when available. */
  private tokensPerChar = 0.25;
  /** Chars actually sent on the last LLM call, used to calibrate the ratio. */
  private lastSentChars = 0;

  constructor(priorMessages: ThreadMessage[], userInput: string) {
    this.items.push({ msg: { role: 'system', content: SYSTEM_PROMPT }, dbId: null });
    for (const p of priorMessages) {
      this.items.push({
        msg: { role: p.role, content: p.content, toolCalls: p.toolCalls, toolCallId: p.toolCallId, collapsed: p.collapsed },
        dbId: p.id,
      });
    }
    this.items.push({ msg: { role: 'user', content: userInput }, dbId: null });
  }

  /** The clean LLM-facing message list (no DB ids leak to providers). */
  all(): LlmMessage[] {
    return this.items.map((i) => i.msg);
  }

  /** Append a freshly produced message, optionally with its persisted DB id. */
  add(message: LlmMessage, dbId: number | null = null): void {
    this.items.push({ msg: message, dbId });
  }

  /** Attach the DB id to the most recently added message (set after persisting it). */
  setLastDbId(dbId: number): void {
    if (this.items.length) this.items[this.items.length - 1].dbId = dbId;
  }

  /** Feed back real token usage so the next estimate is calibrated to this model. */
  recordUsage(usage?: LlmUsage): void {
    if (usage?.inputTokens && this.lastSentChars > 0) {
      const ratio = usage.inputTokens / this.lastSentChars;
      // Clamp to a sane band so one odd response can't wreck the estimator.
      this.tokensPerChar = Math.min(0.6, Math.max(0.15, ratio));
    }
  }

  /** Current estimated token size of the working set. */
  estTokens(): number {
    return estimateTokens(this.all(), this.tokensPerChar);
  }

  /**
   * Run the compaction cascade if the working set is over the warn threshold.
   * Mutates the working list in place. Returns what it did (with the DB ids newly
   * masked), or null if untouched. Always records the post-compaction size.
   */
  maybeCompact(): CompactionResult | null {
    const { contextBudget, compactWarnRatio, compactHardRatio, keepRecentMessages } = config.agent;
    const estBefore = this.estTokens();

    if (estBefore < contextBudget * compactWarnRatio) {
      this.lastSentChars = totalChars(this.all());
      return null;
    }

    const collapsedIds: number[] = [];
    let masked = 0;
    let dropped = 0;

    // L1 — observation masking of old tool results. maskOldToolResults is 1:1 by
    // index, so a newly-masked slot maps straight back to its WorkingMessage/dbId.
    const m1 = maskOldToolResults(this.all(), { keepRecent: keepRecentMessages });
    for (let i = 0; i < this.items.length; i++) {
      if (m1.messages[i].collapsed === 'masked' && this.items[i].msg.collapsed !== 'masked') {
        this.items[i].msg = m1.messages[i];
        masked += 1;
        if (this.items[i].dbId != null) collapsedIds.push(this.items[i].dbId as number);
      }
    }

    // L2 — sliding window, only if masking left us over the hard ratio. This is an
    // in-memory safety valve: it drops rounds but never persists the loss (the full
    // history stays in the DB and is re-derived on the next load).
    if (estimateTokens(this.all(), this.tokensPerChar) >= contextBudget * compactHardRatio) {
      const m2 = slidingWindow(this.all(), { keepRecent: keepRecentMessages });
      if (m2.dropped > 0) {
        const kept = new Set(m2.messages);
        const before = this.items.length;
        this.items = this.items.filter((it) => kept.has(it.msg));
        dropped = before - this.items.length;
      }
    }

    this.lastSentChars = totalChars(this.all());
    return { info: { estBefore, estAfter: this.estTokens(), masked, dropped }, collapsedIds };
  }
}

export { SYSTEM_PROMPT };
