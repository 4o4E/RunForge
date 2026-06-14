import type { LlmMessage, LlmUsage } from '../llm/types.js';
import type { ThreadMessage } from '../store/types.js';
import { config } from '../config.js';
import {
  estimateTokens,
  maskOldAssistantToolCalls,
  maskOldToolResults,
  renderSummaryPrompt,
  slidingWindow,
  summaryCandidate,
  summaryMessage,
  totalChars,
} from './compaction.js';
import type { Provider } from '../llm/types.js';

const SYSTEM_PROMPT = `你是 my-agent，一个通用自主助手。

你以循环方式工作：先思考，必要时调用工具，观察结果，然后继续推进，直到任务完成。
本次 run 只能通过调用 finish_conversation 结束。

行为准则：
- 优先使用工具真实行动，例如运行命令、读写文件、搜索网页。
- 工具有帮助时就调用一个或多个工具，不要只凭猜测回答。
- 不要只靠文字结束本次 run；必须调用 finish_conversation，并且 completed=true，才算完成工作。
- 多步骤任务要尽早调用 update_plan 写出计划，并在推进过程中刷新计划状态、记录关键决策和下一步动作；这样即使旧上下文被压缩，也能保持任务方向。
- 计划必须和最终状态一致：已有 plan 时，结束前所有条目都必须是 done 或 failed；仍是 todo/doing 时不能调用 completed=true。
- 真实执行失败或路径改变时，必须同步调用 update_plan；失败条目标记为 failed 并保留，不要从 plan 里删除。
- 回复要简洁；能合理假设时说明假设，不要频繁打断用户。
- 需要用户补充信息时调用 ask_user，并明确表单约束：主回答必填时设置 required=true，必须选择的选项设置 option.required=true，不要要求用户在普通输入框里回答。
- 默认使用 Markdown 输出；日常报告、表格、代码、Mermaid 图和 LaTeX 公式都直接写在 Markdown 中。
- Mermaid 使用语言名为 "mermaid" 的 fenced code block；行内 LaTeX 公式使用 $...$，独立公式块使用 $$...$$。
- Mermaid 节点 ID 只使用英文字母、数字和下划线；节点标签包含中文、空格、符号、HTML 换行、斜杠或 @ 时必须写成 node_id["标签"]，不要写 http-server[...]/annotation[...<br/>...] 这类容易解析失败的形式。
- 复杂报告或独立页面需要更丰富布局/前端交互时，使用 write_html_artifact 写完整 HTML 文件，并在最终回答中说明生成路径。
- 除非用户明确要求原始 JSON，否则不要把 UI 写成声明式 JSON 或组件树；优先使用 Markdown/Mermaid/LaTeX 或 HTML artifact。
- 涉及数据库、数据源、schema、库表、字段或数据统计时，必须先激活 database-access skill；不要使用宿主进程 DATABASE_URL、长期密码或服务端私密 env 作为捷径。
- 标准流程：
  1. 先用需要的工具收集数据。
  2. 用 Markdown 组织结果；复杂页面则写入 workspace 下的 HTML artifact。
  3. 只有任务完成后，调用 finish_conversation，设置 completed=true，并写清楚工作进度。`;

export interface RuntimeContextInfo {
  workspaceRoot: string;
  sandbox: 'off' | 'enforce';
  sandboxBackend: string;
  shellUseHostPath: boolean;
  network: 'enabled' | 'disabled';
}

export function renderRuntimeContext(info: RuntimeContextInfo): string {
  return `运行时文件系统上下文:
- 持久工作区根目录: ${info.workspaceRoot}
- 请把这个目录视为本次 run 当前可用目录。clone 仓库、创建报告、写入任何需要保留的文件，都必须放在这个目录下。
- 不要把需要保留的文件写到 /home/user、/tmp、应用仓库根目录或 workspace 之外的路径，除非用户明确要求且工具策略允许。
- Python 依赖必须安装在虚拟环境中；优先在工作区创建 .venv 并使用 uv 管理依赖，不要全局安装 pip 包。
- 工具沙箱: ${info.sandbox}; shell 后端: ${info.sandboxBackend}; shell 使用宿主机 PATH: ${info.shellUseHostPath ? '是' : '否'}; 网络: ${info.network}.`;
}

/** What a compaction pass did, surfaced for events/telemetry. */
export interface CompactionInfo {
  estBefore: number;
  estAfter: number;
  masked: number;
  summarized: number;
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

interface ContextOptions {
  appendUserInput?: boolean;
  runtimeContext?: string;
}

/**
 * Holds the working message list for a single run and keeps it under the context
 * budget. A fresh system prompt, the prior thread history (multi-turn memory, already
 * compacted by the store), and the new user input. Before each LLM call the executor
 * calls `maybeCompact()` so a long task never blows past the model window. Masking
 * decisions are reported back so they can be persisted (long-task design §3.3, §4).
 */
export class ContextManager {
  private readonly forceMaskedToolNames: string[] = [];
  private items: WorkingMessage[] = [];
  /** The goal-anchor system message, held by reference so it can be refreshed in
   *  place each step. Kept in the leading system block so compaction never drops it. */
  private goalItem: WorkingMessage;
  /** Tokens-per-char ratio, calibrated from real provider usage when available. */
  private tokensPerChar = 0.25;
  /** Chars actually sent on the last LLM call, used to calibrate the ratio. */
  private lastSentChars = 0;

  constructor(priorMessages: ThreadMessage[], userInput: string, initialGoal = '', opts: ContextOptions = {}) {
    const appendUserInput = opts.appendUserInput ?? true;
    this.items.push({ msg: { role: 'system', content: SYSTEM_PROMPT }, dbId: null });
    if (opts.runtimeContext) this.items.push({ msg: { role: 'system', content: opts.runtimeContext }, dbId: null });
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

  /** Apply cheap L1 masking and return newly collapsed DB ids. */
  private maskOldPayloads(keepRecent: number): { collapsedIds: number[]; masked: number } {
    const collapsedIds: number[] = [];
    let masked = 0;
    const m1 = maskOldToolResults(this.all(), { keepRecent });
    const m2 = maskOldAssistantToolCalls(m1.messages, { keepRecent, forceToolNames: this.forceMaskedToolNames });
    for (let i = 0; i < this.items.length; i++) {
      if (m2.messages[i].collapsed === 'masked' && this.items[i].msg.collapsed !== 'masked') {
        this.items[i].msg = m2.messages[i];
        masked += 1;
        if (this.items[i].dbId != null) collapsedIds.push(this.items[i].dbId as number);
      }
    }
    return { collapsedIds, masked };
  }

  /** 展示型工具的大参数没有推理价值，即使整体预算没超也要在模型调用前清理。 */
  private maskForcedToolCallPayloads(): { collapsedIds: number[]; masked: number } {
    const collapsedIds: number[] = [];
    let masked = 0;
    const m1 = maskOldAssistantToolCalls(this.all(), {
      keepRecent: Number.MAX_SAFE_INTEGER,
      forceToolNames: this.forceMaskedToolNames,
    });
    for (let i = 0; i < this.items.length; i++) {
      if (m1.messages[i].collapsed === 'masked' && this.items[i].msg.collapsed !== 'masked') {
        this.items[i].msg = m1.messages[i];
        masked += 1;
        if (this.items[i].dbId != null) collapsedIds.push(this.items[i].dbId as number);
      }
    }
    return { collapsedIds, masked };
  }

  /** Run-end cleanup: shrink old bulky payloads for future turns even when this
   *  run stayed below the live compaction threshold. */
  compactForHistory(reason = 'post-run-history'): CompactionResult | null {
    const { keepRecentMessages } = config.agent;
    const estBefore = this.estTokens();
    const { collapsedIds, masked } = this.maskOldPayloads(keepRecentMessages);
    this.lastSentChars = totalChars(this.all());
    if (!masked) return null;
    return {
      info: { estBefore, estAfter: this.estTokens(), masked, summarized: 0, dropped: 0, reason },
      collapsedIds,
      summarizedIds: [],
    };
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
      const forced = this.maskForcedToolCallPayloads();
      this.lastSentChars = totalChars(this.all());
      if (forced.masked) {
        return {
          info: { estBefore, estAfter: this.estTokens(), masked: forced.masked, summarized: 0, dropped: 0, reason: 'display-payload' },
          collapsedIds: forced.collapsedIds,
          summarizedIds: [],
        };
      }
      return null;
    }

    const summarizedIds: number[] = [];
    let summarized = 0;
    let dropped = 0;
    const reason = `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}`;

    // L1 — mask old bulky tool results and assistant tool-call arguments. Both
    // keep message structure intact, so persisted history can be compact but valid.
    const { collapsedIds, masked } = this.maskOldPayloads(keepRecentMessages);

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
