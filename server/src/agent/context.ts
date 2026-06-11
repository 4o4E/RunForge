import type { LlmMessage, LlmUsage } from '../llm/types.js';
import type { ThreadMessage } from '../store/types.js';
import { config } from '../config.js';
import {
  estimateTokens,
  maskOldToolResults,
  renderSummaryPrompt,
  slidingWindow,
  summaryCandidate,
  summaryMessage,
  totalChars,
} from './compaction.js';
import type { Provider } from '../llm/types.js';

const SYSTEM_PROMPT = `You are my-agent, a general-purpose autonomous assistant.

You operate in a loop: think, call tools when useful, observe results, and continue
until the task is complete. You may only finish by calling finish_conversation.

Guidelines:
- Prefer tools to act on the world (run commands, read/write files, search the web).
- Call one or more tools when they help.
- Do not end the run just by writing text. If finish_conversation has not been
  called with completed=true, the work is not complete.
- 不要只靠文字结束本次 run；必须调用 finish_conversation，并且 completed=true，才算完成工作。
- For any task that takes more than a few steps, call update_plan early to lay out
  your plan, and refresh it (mark steps done, record key decisions, set the next
  action) as you go — it keeps you on track even after older context is compacted.
- Be concise. State assumptions you made instead of asking when possible.
- When you need user input, call ask_user and make the form explicit: set
  required=true when the main answer must be provided, set option.required=true
  for options that must be selected, and do not ask the user to answer in the
  normal chat box. / 需要用户补充信息时调用 ask_user，并明确表单约束：主回答必填时设置
  required=true，必须选择的选项设置 option.required=true，不要要求用户在普通输入框里回答。
- For structured results the user would benefit from seeing as a rich UI (tables,
  key/value summaries, cards), call the render_ui tool with an A2UI component
  description in addition to your text answer.
- Final summary must be rendered with AgentUI/A2UI first by calling render_ui,
  then followed by a short text answer.
- 最后的总结必须先调用 render_ui，用 AgentUI/A2UI 输出结构化界面，然后再给一段简短文字结论。
- Example flow / 示例流程:
  1. Collect data with the needed tools / 先用需要的工具收集数据。
  2. After enough data is collected, call render_ui multiple times with the same
     surfaceId to update AgentUI in batches / 数据收集后，使用相同 surfaceId 分批调用
     render_ui 更新 AgentUI。
  3. When and only when the task is complete, call finish_conversation with
     completed=true and a clear progress summary / 只有任务完成后，调用
     finish_conversation，设置 completed=true，并写清楚工作进度。`;

/** What a compaction pass did, surfaced for events/telemetry. */
export interface CompactionInfo {
  estBefore: number;
  estAfter: number;
  masked: number;
  summarized?: number;
  dropped: number;
  reason?: string;
}

export interface CompactionResult {
  info: CompactionInfo;
  /** DB ids newly masked this pass — the executor persists these so the decision
   *  survives a restart. (Window drops are in-memory only and never persisted.) */
  collapsedIds: number[];
  summarizedIds: number[];
  summaryMessage?: LlmMessage;
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
  /** The goal-anchor system message, held by reference so it can be refreshed in
   *  place each step. Kept in the leading system block so compaction never drops it. */
  private goalItem: WorkingMessage;
  /** Tokens-per-char ratio, calibrated from real provider usage when available. */
  private tokensPerChar = 0.25;
  /** Chars actually sent on the last LLM call, used to calibrate the ratio. */
  private lastSentChars = 0;

  constructor(priorMessages: ThreadMessage[], userInput: string, initialGoal = '', opts: { appendUserInput?: boolean } = {}) {
    const appendUserInput = opts.appendUserInput ?? true;
    this.items.push({ msg: { role: 'system', content: SYSTEM_PROMPT }, dbId: null });
    this.goalItem = { msg: { role: 'system', content: initialGoal }, dbId: null };
    this.items.push(this.goalItem);
    for (const p of priorMessages) {
      this.items.push({
        msg: { role: p.role, content: p.content, toolCalls: p.toolCalls, toolCallId: p.toolCallId, collapsed: p.collapsed },
        dbId: p.id,
      });
    }
    if (appendUserInput) this.items.push({ msg: { role: 'user', content: userInput }, dbId: null });
  }

  /** Refresh the goal-anchor system message (re-injected every step, drift defense). */
  setGoal(rendered: string): void {
    this.goalItem.msg = { role: 'system', content: rendered };
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

  /** L3 摘要是 splice 进工作上下文的，不一定是最后一条，所以按对象引用回填 DB id。 */
  setSummaryDbId(message: LlmMessage, dbId: number): void {
    const item = this.items.find((it) => it.msg === message);
    if (item) item.dbId = dbId;
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
  async maybeCompact(provider?: Provider): Promise<CompactionResult | null> {
    const { contextBudget, compactWarnRatio, compactHardRatio, keepRecentMessages, contextBudgetSource, modelContextWindow } =
      config.agent;
    const estBefore = this.estTokens();

    if (estBefore < contextBudget * compactWarnRatio) {
      this.lastSentChars = totalChars(this.all());
      return null;
    }

    const collapsedIds: number[] = [];
    const summarizedIds: number[] = [];
    let masked = 0;
    let summarized = 0;
    let dropped = 0;
    const reason = `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}`;

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

    let l3Summary: LlmMessage | undefined;
    // L3 — 锚定摘要。只有 L1 后仍超过硬阈值才调用模型，摘要替换旧区间，原文只打标不删除。
    if (provider && estimateTokens(this.all(), this.tokensPerChar) >= contextBudget * compactHardRatio) {
      const candidate = summaryCandidate(this.all(), { keepRecent: keepRecentMessages });
      if (candidate) {
        const ids = this.items.slice(candidate.start, candidate.end).map((it) => it.dbId).filter((id): id is number => id != null);
        if (ids.length) {
          const summary = await provider.complete(renderSummaryPrompt(candidate.messages, this.goalItem.msg.content ?? ''), []);
          l3Summary = summaryMessage(summary.content || 'Earlier context was summarized, but the model returned an empty summary.');
          this.items.splice(candidate.start, candidate.end - candidate.start, { msg: l3Summary, dbId: null });
          summarizedIds.push(...ids);
          summarized = ids.length;
        }
      }
    }

    // L2 — sliding window, only if masking/L3 left us over the hard ratio. This is an
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
    return {
      info: { estBefore, estAfter: this.estTokens(), masked, summarized, dropped, reason },
      collapsedIds,
      summarizedIds,
      summaryMessage: l3Summary,
    };
  }
}

export { SYSTEM_PROMPT };
