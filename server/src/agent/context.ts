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
本次 run 以最终汇报自然结束：没有工具调用且输出可见正文时，系统会结束 run 并收敛计划状态。

行为准则：
- 优先使用工具真实行动，例如运行命令、读写文件、搜索网页。
- 工具有帮助时就调用一个或多个工具，不要只凭猜测回答。
- 多步骤任务要尽早调用 update_plan 写出计划，并在推进过程中刷新计划状态、记录关键决策和下一步动作；这样即使旧上下文被压缩，也能保持任务方向。
- 计划里的最后一步如果是“汇报结果/总结/最终回答”，创建计划时就把该 plan item 设置为 autoComplete=true；输出完整最终正文后，运行时会自动把这一步标记为 done，不要再回头调用 update_plan 只为修改这一步。
- Auto-complete report step / 自动完成汇报步骤: when the final plan item is final reporting or summary, set autoComplete=true when creating the plan; after the complete final answer is written, the runtime will mark it done automatically, so do not call update_plan afterward only to close that item.
- 最终汇报必须是没有任何工具调用的可见正文；不要把完整答案放进 reasoning/思考里，也不要在同一轮最终正文后继续调用工具。
- Final answer rule / 最终回答规则: the complete final answer must be a visible assistant message with no tool calls; do not place the answer in reasoning/thinking, and do not call tools in the same turn as the final answer.
- update_plan 只更新计划，永远不会结束 run；如果还没输出最终正文，尽量先调用 update_plan 把 phase 设置为 reporting 或 completed，然后在下一轮输出无工具调用的完整最终回答。
- Plan close-out rule / 计划收口规则: update_plan only updates the plan and never finishes the run; if the final answer has not been written yet, preferably set phase to reporting/completed first, then output the complete final answer with no tool calls in the next assistant turn.
- 一旦已经输出无工具调用的完整最终正文，不要再调用 update_plan 只为关闭计划；运行时会结束 run，未完成的计划条目会保留为状态记录。
- No post-final plan turn / 最终回答后不补计划轮次: after writing the complete final answer without tool calls, do not call update_plan only to close the plan; the runtime will finish the run and keep unfinished plan items as state records.
- 真实执行失败或路径改变时，必须同步调用 update_plan；失败条目标记为 failed 并保留，不要从 plan 里删除。
- 回复要简洁；能合理假设时说明假设，不要频繁打断用户。
- 需要用户补充信息时调用 ask_user，并明确表单约束：主回答必填时设置 required=true，必须选择的选项设置 option.required=true，不要要求用户在普通输入框里回答。
- 默认使用 Markdown 输出；日常报告、表格、代码、Mermaid 图和 LaTeX 公式都直接写在 Markdown 中。
- 提到 workspace 内的文件时，必须使用 Markdown 链接语法，优先写 workspace 相对路径，例如 [server/src/agent/context.ts](server/src/agent/context.ts)；不要只输出裸文件路径。
- File link rule / 文件链接规则: when mentioning workspace files, use Markdown links like [web/src/App.tsx](web/src/App.tsx), preferably with workspace-relative paths; do not output bare file paths.
- Mermaid 使用语言名为 "mermaid" 的 fenced code block；行内 LaTeX 公式使用 $...$，独立公式块使用 $$...$$。
- Mermaid 节点 ID 只使用英文字母、数字和下划线；节点标签包含中文、空格、符号、HTML 换行、斜杠或 @ 时必须写成 node_id["标签"]，不要写 http-server[...]/annotation[...<br/>...] 这类容易解析失败的形式。
- 数据分析、对比、趋势、占比、流程和架构图默认优先用 Markdown/Mermaid 直接输出；不要因为“复杂”就默认生成 HTML。
- 仅在 Mermaid/Markdown 无法表达的图型（如散点图、气泡图、热力图、地图、桑基图）、用户明确要求交互/独立页面，或需要筛选、排序、缩放、钻取等控件时，才生成 HTML artifact。
- HTML artifact generation / HTML artifact 生成规则: create complete .html/.htm files under the workspace, preferably artifacts/<descriptive-name>.html, by using shell or file-writing tools; do not put the full HTML document into a tool-call argument. 使用 shell 或文件写入工具在 workspace 下创建完整 .html/.htm 文件，优先放在 artifacts/<描述性名称>.html；不要把完整 HTML 文档塞进工具调用参数。
- Artifact link rule / Artifact 链接规则: after creating an artifact, the final answer must mention it with Markdown link syntax, for example [artifacts/report.html](artifacts/report.html), so the user can open it directly. 创建 artifact 后，最终回答必须用 Markdown 链接语法说明，例如 [artifacts/report.html](artifacts/report.html)，方便用户直接跳转。
- 除非用户明确要求原始 JSON，否则不要把 UI 写成声明式 JSON 或组件树；优先使用 Markdown/Mermaid/LaTeX 或 HTML artifact。
- 涉及数据库、数据源、schema、库表、字段或数据统计时，必须先激活 database-access skill；不要使用宿主进程 DATABASE_URL、长期密码或服务端私密 env 作为捷径。
- 标准流程：
  1. 先用需要的工具收集数据。
  2. 用 Markdown/Mermaid 组织结果；只有明确需要交互或独立页面时才通过 shell 或文件写入工具写入 workspace 下的 HTML artifact。
  3. 任务完成且尚未输出最终正文时，先尽量调用 update_plan 收口计划；随后输出一段没有工具调用的完整最终汇报。`;

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
- 工具沙箱: ${info.sandbox}; shell 后端: ${info.sandboxBackend}; shell 使用宿主机 PATH: ${info.shellUseHostPath ? '是' : '否'}; 网络: ${info.network}.
- shell 是托管资源 / Shell is a managed resource: 优先用 shell_session_reuse/open 获取 session，再用 shell_exec 执行命令；短命令用 wait=foreground，长命令用 wait=background 后用 shell_poll 观察，必要时 shell_kill 终止。
- shell session 会长期记住当前目录 / The shell session remembers cwd across commands: 需要切目录时直接执行 cd，不要给每次命令单独传 cwd。旧 shell 工具只是兼容入口。`;
}

/** 一次压缩实际做了什么，用于事件和遥测。 */
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
  /** 本次新增 mask 的 DB id，executor 会落库；窗口丢弃只在内存中发生。 */
  collapsedIds: number[];
  summarizedIds: number[];
  summaryMessage?: LlmMessage;
}

/** 工作上下文里的消息及其 DB 行；null 表示尚未落库或不可 mask，例如 system prompt。 */
interface WorkingMessage {
  msg: LlmMessage;
  dbId: number | null;
}

interface ContextOptions {
  appendUserInput?: boolean;
  runtimeContext?: string;
}

/**
 * 管理单个 run 的工作消息列表，并把它压在上下文预算内。
 * 每次模型调用前由 executor 调用 maybeCompact()，避免长任务撞上模型窗口；
 * mask 决策会返回给 executor 落库。
 */
export class ContextManager {
  private readonly forceMaskedToolNames: string[] = [];
  private items: WorkingMessage[] = [];
  /** 目标锚点 system 消息按引用保存，每步可原地刷新，并放在前置 system 区避免被压缩丢掉。 */
  private goalItem: WorkingMessage;
  /** 每字符 token 估算比例，有真实 provider 用量时会校准。 */
  private tokensPerChar = 0.25;
  /** 上次模型调用实际发送的字符数，用于校准比例。 */
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

  /** 刷新目标锚点 system 消息；每步重注入，用来防止目标漂移。 */
  setGoal(rendered: string): void {
    this.goalItem.msg = { role: 'system', content: rendered };
  }

  /** 返回干净的模型消息列表，不把 DB id 泄露给 provider。 */
  all(): LlmMessage[] {
    return this.items.map((i) => i.msg);
  }

  /** 追加新生成消息，可同时带上已落库的 DB id。 */
  add(message: LlmMessage, dbId: number | null = null): void {
    this.items.push({ msg: message, dbId });
  }

  /** 给最近追加的消息补上落库后的 DB id。 */
  setLastDbId(dbId: number): void {
    if (this.items.length) this.items[this.items.length - 1].dbId = dbId;
  }

  /** L3 摘要是 splice 进工作上下文的，不一定是最后一条，所以按对象引用回填 DB id。 */
  setSummaryDbId(message: LlmMessage, dbId: number): void {
    const item = this.items.find((it) => it.msg === message);
    if (item) item.dbId = dbId;
  }

  /** 回填真实 token 用量，让下一次估算贴近当前模型。 */
  recordUsage(usage?: LlmUsage): void {
    if (usage?.inputTokens && this.lastSentChars > 0) {
      const ratio = usage.inputTokens / this.lastSentChars;
      // 限制在合理区间内，避免单次异常响应把估算器带偏。
      this.tokensPerChar = Math.min(0.6, Math.max(0.15, ratio));
    }
  }

  /** 当前工作上下文的估算 token 数。 */
  estTokens(): number {
    return estimateTokens(this.all(), this.tokensPerChar);
  }

  /** 执行低成本 L1 mask，并返回本次新折叠的 DB id。 */
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

  /** run 结束清理：即使本轮没触发实时压缩，也为后续轮次收缩旧的大 payload。 */
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
   * 工作上下文超过警戒线时执行压缩级联。
   * 这里会原地修改工作列表；有改动则返回新 mask 的 DB id 和压缩结果，否则返回 null。
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

    // L1：mask 旧的大工具结果和 assistant 工具参数，同时保持消息结构合法。
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

    // L2：滑动窗口只作为内存安全阀，不落库丢弃；完整历史仍保留在 DB 中。
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
