import type { LlmMessage, LlmUsage } from '../llm/types.js';
import type { CompactionAffectedMessage } from '@runforge/contracts';
import type { ThreadMessage } from '../store/types.js';
import type { Provider } from '../llm/types.js';
import { config, type AgentContextSettings } from '../config.js';
import {
  createContextCompactor,
  type CompactionInfo,
  type CompactionResult,
  type ContextCompactor,
  type WorkingMessage,
} from './contextCompactor.js';
import { estimateTokens, maskPlaceholder, totalChars } from './compaction.js';

export type { CompactionInfo, CompactionResult };

interface ContextOptions {
  appendUserInput?: boolean;
  systemPrompt?: string;
  contextSettings?: AgentContextSettings;
}

/**
 * 管理单个 run 的工作消息列表，并把它压在上下文预算内。
 * 每次模型调用前由 executor 调用 maybeCompact()，避免长任务撞上模型窗口；
 * mask 决策会返回给 executor 落库。
 */
export class ContextManager {
  private readonly forceMaskedToolNames: string[] = [];
  private readonly compactor: ContextCompactor = createContextCompactor();
  private items: WorkingMessage[] = [];
  /** Goal 只供压缩摘要使用；普通模型请求通过 update_plan 工具结果读取最新状态。 */
  private goalContent: string;
  /** 每字符 token 估算比例，有真实 provider 用量时会校准。 */
  private tokensPerChar = 0.25;
  private readonly contextSettings: AgentContextSettings;
  /** 上次模型调用实际发送的字符数，用于校准比例。 */
  private lastSentChars = 0;

  constructor(priorMessages: ThreadMessage[], userInput: string, initialGoal = '', opts: ContextOptions = {}) {
    this.contextSettings = opts.contextSettings ?? {
      modelContextWindow: config.agent.modelContextWindow,
      contextBudget: config.agent.contextBudget,
      contextBudgetSource: config.agent.contextBudgetSource,
    };
    this.goalContent = initialGoal;
    const appendUserInput = opts.appendUserInput ?? true;
    const systemPrompt = opts.systemPrompt?.trim();
    if (systemPrompt) this.items.push({ msg: { role: 'system', content: systemPrompt }, dbId: null });
    for (const p of priorMessages) {
      this.items.push({
        msg: {
          role: p.role,
          content: p.content,
          toolCalls: p.toolCalls,
          toolCallId: p.toolCallId,
          providerState: p.providerState,
          collapsed: p.collapsed,
        },
        dbId: p.id,
      });
    }
    if (appendUserInput) {
      this.items.push({ msg: { role: 'user', content: userInput }, dbId: null });
    }
    this.pruneSupersededGoalUpdates();
  }

  /** 刷新供压缩摘要使用的 Goal；普通请求不会额外注入 Goal system 消息。 */
  setGoal(rendered: string): void {
    this.goalContent = rendered;
  }

  /** 返回干净的模型消息列表，不把 DB id 泄露给 provider。 */
  all(): LlmMessage[] {
    return this.items.map((i) => i.msg);
  }

  /** 追加新生成消息，可同时带上已落库的 DB id。 */
  add(message: LlmMessage, dbId: number | null = null): void {
    this.items.push({ msg: message, dbId });
    this.pruneSupersededGoalUpdates();
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

  /** run 结束清理：即使本轮没触发实时压缩，也为后续轮次收缩旧的大 payload。 */
  compactForHistory(reason = 'post-run-history'): CompactionResult | null {
    const before = this.items;
    const result = this.compactor.compactForHistory(this.compactionInput(), reason);
    return this.applyCompactionOutput(result, before);
  }

  /**
   * 某些工具结果只需要被下一次 LLM 请求完整消费一次。请求完成后立即折叠，既保留
   * tool_call/tool_result 配对和原始落库内容，也避免长入口说明持续占用上下文。
   */
  collapseConsumedToolResults(toolNames: string[], reason = 'consumed-tool-result'): CompactionResult | null {
    const before = this.items;
    const items = this.cloneItems(this.items);
    const wanted = new Set(toolNames);
    const nameByCallId = new Map<string, string>();
    for (const item of items) {
      for (const call of item.msg.toolCalls ?? []) nameByCallId.set(call.id, call.name);
    }

    const collapsedIds: number[] = [];
    for (const item of items) {
      const message = item.msg;
      if (message.role !== 'tool' || message.collapsed || !message.toolCallId) continue;
      if (!wanted.has(nameByCallId.get(message.toolCallId) ?? '')) continue;
      item.msg = { ...message, content: maskPlaceholder(message.content ?? ''), collapsed: 'masked' };
      if (item.dbId != null) collapsedIds.push(item.dbId);
    }
    if (!collapsedIds.length) return null;

    const estBefore = estimateTokens(this.all(), this.tokensPerChar);
    return this.applyCompactionOutput({
      items,
      sentChars: totalChars(items.map((item) => item.msg)),
      info: {
        estBefore,
        estAfter: estimateTokens(items.map((item) => item.msg), this.tokensPerChar),
        masked: collapsedIds.length,
        summarized: 0,
        dropped: 0,
        reason,
      },
      collapsedIds,
      summarizedIds: [],
    }, before);
  }

  /**
   * 工作上下文超过警戒线时执行压缩级联。
   * 这里会原地修改工作列表；有改动则返回新 mask 的 DB id 和压缩结果，否则返回 null。
   */
  async maybeCompact(provider?: Provider): Promise<CompactionResult | null> {
    const before = this.items;
    const result = await this.compactor.compact(this.compactionInput(provider));
    return this.applyCompactionOutput(result, before);
  }

  private compactionInput(provider?: Provider) {
    const items = this.cloneItems(this.items);
    return {
      // 压缩策略可替换消息对象；传入副本后才能可靠比较压缩前后内容并生成审计明细。
      items,
      goalContent: this.goalContent,
      tokensPerChar: this.tokensPerChar,
      provider,
      forceMaskedToolNames: this.forceMaskedToolNames,
      contextSettings: this.contextSettings,
    };
  }

  private cloneItems(items: WorkingMessage[]): WorkingMessage[] {
    // 压缩函数只替换 WorkingMessage.msg，不会修改 LlmMessage 内部字段；复制包装器
    // 即可隔离策略写入，同时避免每轮复制可能很大的 encrypted_content。
    return items.map((item) => ({ ...item }));
  }

  /**
   * update_plan 的最新工具结果已经包含合并后的完整 Goal。更早的参数和结果只在
   * provider 派生视图中缩成占位内容，原始 messages 记录保持不变。
   */
  private pruneSupersededGoalUpdates(): void {
    const resultIndexByCallId = new Map<string, number>();
    for (let index = 0; index < this.items.length; index += 1) {
      const message = this.items[index].msg;
      if (message.role === 'tool' && message.toolCallId) resultIndexByCallId.set(message.toolCallId, index);
    }
    const pairs: Array<{ assistantIndex: number; callIndex: number; resultIndex: number }> = [];
    for (let assistantIndex = 0; assistantIndex < this.items.length; assistantIndex += 1) {
      const calls = this.items[assistantIndex].msg.toolCalls ?? [];
      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        const call = calls[callIndex];
        const resultIndex = call.name === 'update_plan' ? resultIndexByCallId.get(call.id) : undefined;
        if (resultIndex !== undefined && resultIndex > assistantIndex) pairs.push({ assistantIndex, callIndex, resultIndex });
      }
    }
    if (pairs.length < 2) return;
    const latest = pairs.reduce((current, pair) => pair.resultIndex > current.resultIndex ? pair : current);
    for (const pair of pairs) {
      if (pair === latest) continue;
      const assistant = this.items[pair.assistantIndex];
      const calls = [...(assistant.msg.toolCalls ?? [])];
      calls[pair.callIndex] = { ...calls[pair.callIndex], arguments: '{"superseded":true}' };
      assistant.msg = { ...assistant.msg, toolCalls: calls };
      const result = this.items[pair.resultIndex];
      result.msg = {
        ...result.msg,
        content: '这次 Goal 更新已被后续完整 Goal 状态取代。',
      };
    }
  }

  private affectedMessages(
    before: WorkingMessage[],
    after: WorkingMessage[],
    collapsedIds: number[],
    summarizedIds: number[],
  ): CompactionAffectedMessage[] {
    const beforeById = new Map(before.filter((item) => item.dbId != null).map((item) => [item.dbId as number, item.msg]));
    const afterById = new Map(after.filter((item) => item.dbId != null).map((item) => [item.dbId as number, item.msg]));
    const summarized = new Set(summarizedIds);
    const collapsed = new Set(collapsedIds);
    const nameByToolCallId = new Map<string, string>();
    for (const item of before) {
      for (const call of item.msg.toolCalls ?? []) nameByToolCallId.set(call.id, call.name);
    }

    const ids = new Set<number>([...collapsedIds, ...summarizedIds]);
    for (const id of beforeById.keys()) {
      if (!afterById.has(id) && !summarized.has(id)) ids.add(id);
    }

    return [...ids].flatMap((messageId) => {
      const original = beforeById.get(messageId);
      if (!original) return [];
      const compacted = afterById.get(messageId);
      const action: CompactionAffectedMessage['action'] = summarized.has(messageId)
        ? 'summarized'
        : collapsed.has(messageId)
          ? 'masked'
          : 'dropped';
      const toolCallIds = original.role === 'assistant'
        ? (original.toolCalls ?? []).map((call) => call.id)
        : original.toolCallId
          ? [original.toolCallId]
          : [];
      const replacement = action === 'summarized'
        ? undefined
        : compacted?.role === 'tool'
          ? compacted.content ?? undefined
          : compacted?.role === 'assistant' && compacted.toolCalls
            ? JSON.stringify({
                context_elided: true,
                tool_calls: compacted.toolCalls.map((call) => ({ id: call.id, name: call.name })),
                note: '历史工具调用参数已动态裁剪；原始参数仅在 Debug 模式可见。',
              })
            : undefined;
      return [{
        messageId,
        action,
        role: original.role,
        toolCallIds,
        toolNames: toolCallIds.map((id) => nameByToolCallId.get(id)).filter((name): name is string => Boolean(name)),
        originalChars: totalChars([original]),
        replacement,
      }];
    });
  }

  private applyCompactionOutput(
    result: ({
      info: CompactionInfo;
      collapsedIds: number[];
      summarizedIds: number[];
      summaryMessage?: LlmMessage;
      items?: WorkingMessage[];
      sentChars?: number;
    }) | null,
    before: WorkingMessage[],
  ): CompactionResult | null {
    if (!result) {
      this.lastSentChars = totalChars(this.all());
      return null;
    }
    if (result.items) this.items = result.items;
    this.lastSentChars = result.sentChars ?? totalChars(this.all());
    return {
      info: result.info,
      collapsedIds: result.collapsedIds,
      summarizedIds: result.summarizedIds,
      summaryMessage: result.summaryMessage,
      affected: this.affectedMessages(
        before,
        result.items ?? this.items,
        result.collapsedIds,
        result.summarizedIds,
      ),
    };
  }
}
