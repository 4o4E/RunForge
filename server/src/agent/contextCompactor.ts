import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  trimMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import { config } from '../config.js';
import type { LlmMessage } from '../llm/types.js';
import type { Provider } from '../llm/types.js';
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

export interface WorkingMessage {
  msg: LlmMessage;
  dbId: number | null;
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

export interface ContextCompactionInput {
  items: WorkingMessage[];
  goalContent: string;
  tokensPerChar: number;
  provider?: Provider;
  forceMaskedToolNames: string[];
}

export interface ContextCompactionOutput extends CompactionResult {
  items: WorkingMessage[];
  sentChars: number;
}

export interface ContextCompactor {
  readonly name: typeof config.agent.contextStrategy;
  compact(input: ContextCompactionInput): Promise<ContextCompactionOutput | null>;
  compactForHistory(input: ContextCompactionInput, reason?: string): ContextCompactionOutput | null;
}

function messagesOf(items: WorkingMessage[]): LlmMessage[] {
  return items.map((item) => item.msg);
}

function dbIds(items: WorkingMessage[]): number[] {
  return items.map((it) => it.dbId).filter((id): id is number => id != null);
}

function maskPayloads(items: WorkingMessage[], keepRecent: number, forceToolNames: string[] = []): { collapsedIds: number[]; masked: number } {
  const collapsedIds: number[] = [];
  let masked = 0;
  const m1 = maskOldToolResults(messagesOf(items), { keepRecent });
  const m2 = maskOldAssistantToolCalls(m1.messages, { keepRecent, forceToolNames });
  for (let i = 0; i < items.length; i++) {
    if (m2.messages[i].collapsed === 'masked' && items[i].msg.collapsed !== 'masked') {
      items[i].msg = m2.messages[i];
      masked += 1;
      if (items[i].dbId != null) collapsedIds.push(items[i].dbId as number);
    }
  }
  return { collapsedIds, masked };
}

function maskForcedToolCallPayloads(items: WorkingMessage[], forceToolNames: string[]): { collapsedIds: number[]; masked: number } {
  return maskPayloads(items, Number.MAX_SAFE_INTEGER, forceToolNames);
}

/** 当前 RunForge 策略：L1 mask、L3 摘要、L2 内存窗口，保持既有行为。 */
class CurrentContextCompactor implements ContextCompactor {
  readonly name: ContextCompactor['name'] = 'current';

  compactForHistory(input: ContextCompactionInput, reason = 'post-run-history'): ContextCompactionOutput | null {
    const items = [...input.items];
    const estBefore = estimateTokens(messagesOf(items), input.tokensPerChar);
    const { collapsedIds, masked } = maskPayloads(items, config.agent.keepRecentMessages, input.forceMaskedToolNames);
    const sentChars = totalChars(messagesOf(items));
    if (!masked) return null;
    return {
      items,
      sentChars,
      info: { estBefore, estAfter: estimateTokens(messagesOf(items), input.tokensPerChar), masked, summarized: 0, dropped: 0, reason },
      collapsedIds,
      summarizedIds: [],
    };
  }

  async compact(input: ContextCompactionInput): Promise<ContextCompactionOutput | null> {
    const { contextBudget, compactWarnRatio, compactHardRatio, keepRecentMessages, contextBudgetSource, modelContextWindow } =
      config.agent;
    const items = [...input.items];
    const estBefore = estimateTokens(messagesOf(items), input.tokensPerChar);

    if (estBefore < contextBudget * compactWarnRatio) {
      const forced = maskForcedToolCallPayloads(items, input.forceMaskedToolNames);
      const sentChars = totalChars(messagesOf(items));
      if (forced.masked) {
        return {
          items,
          sentChars,
          info: { estBefore, estAfter: estimateTokens(messagesOf(items), input.tokensPerChar), masked: forced.masked, summarized: 0, dropped: 0, reason: 'display-payload' },
          collapsedIds: forced.collapsedIds,
          summarizedIds: [],
        };
      }
      return null;
    }

    const summarizedIds: number[] = [];
    let summarized = 0;
    let dropped = 0;
    const reason = `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=current`;

    const { collapsedIds, masked } = maskPayloads(items, keepRecentMessages, input.forceMaskedToolNames);

    let l3Summary: LlmMessage | undefined;
    if (input.provider && estimateTokens(messagesOf(items), input.tokensPerChar) >= contextBudget * compactHardRatio) {
      const candidate = summaryCandidate(messagesOf(items), { keepRecent: keepRecentMessages });
      if (candidate) {
        const ids = dbIds(items.slice(candidate.start, candidate.end));
        if (ids.length) {
          const summary = await input.provider.complete(renderSummaryPrompt(candidate.messages, input.goalContent), []);
          l3Summary = summaryMessage(summary.content || 'Earlier context was summarized, but the model returned an empty summary.\n较早上下文已被摘要，但模型返回了空摘要。');
          items.splice(candidate.start, candidate.end - candidate.start, { msg: l3Summary, dbId: null });
          summarizedIds.push(...ids);
          summarized = ids.length;
        }
      }
    }

    if (estimateTokens(messagesOf(items), input.tokensPerChar) >= contextBudget * compactHardRatio) {
      const m2 = slidingWindow(messagesOf(items), { keepRecent: keepRecentMessages });
      if (m2.dropped > 0) {
        const kept = new Set(m2.messages);
        const before = items.length;
        const keptItems = items.filter((it) => kept.has(it.msg));
        items.splice(0, items.length, ...keptItems);
        dropped = before - items.length;
      }
    }

    const sentChars = totalChars(messagesOf(items));
    return {
      items,
      sentChars,
      info: { estBefore, estAfter: estimateTokens(messagesOf(items), input.tokensPerChar), masked, summarized, dropped, reason },
      collapsedIds,
      summarizedIds,
      summaryMessage: l3Summary,
    };
  }
}

function toLangChainMessage(message: LlmMessage, id: string): BaseMessage {
  if (message.role === 'system') return new SystemMessage({ id, content: message.content ?? '' });
  if (message.role === 'user') return new HumanMessage({ id, content: message.content ?? '' });
  if (message.role === 'tool') return new ToolMessage({ id, content: message.content ?? '', tool_call_id: message.toolCallId ?? id });
  return new AIMessage({
    id,
    content: message.content ?? '',
    tool_calls: (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      args: safeJsonObject(call.arguments),
    })),
  });
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function langChainTokenCounter(tokensPerChar: number) {
  return (messages: BaseMessage[]) => {
    const asRunForge: LlmMessage[] = messages.map((message) => {
      const type = message.getType();
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      if (type === 'system') return { role: 'system', content };
      if (type === 'human') return { role: 'user', content };
      if (type === 'tool') return { role: 'tool', content, toolCallId: (message as ToolMessage).tool_call_id };
      const ai = message as AIMessage;
      return {
        role: 'assistant',
        content,
        toolCalls: ai.tool_calls?.map((call) => ({ id: call.id ?? '', name: call.name, arguments: JSON.stringify(call.args ?? {}) })),
      };
    });
    return estimateTokens(asRunForge, tokensPerChar);
  };
}

function leadingSystemEnd(items: WorkingMessage[]): number {
  let i = 0;
  while (i < items.length && items[i].msg.role === 'system') i += 1;
  return i;
}

function protectedPrefixEnd(items: WorkingMessage[]): number {
  const sysEnd = leadingSystemEnd(items);
  const firstUserIdx = items.findIndex((item, i) => i >= sysEnd && item.msg.role === 'user');
  return firstUserIdx >= 0 ? firstUserIdx + 1 : sysEnd;
}

function repairToolPairs(items: WorkingMessage[]): WorkingMessage[] {
  const answeredToolCalls = new Set(items.map((item) => item.msg.role === 'tool' ? item.msg.toolCallId : undefined).filter(Boolean));
  const withAnsweredAssistantCalls = items.filter((item) => {
    if (item.msg.role !== 'assistant' || !item.msg.toolCalls?.length) return true;
    return item.msg.toolCalls.every((call) => answeredToolCalls.has(call.id));
  });

  const seenToolCalls = new Set<string>();
  return withAnsweredAssistantCalls.filter((item) => {
    if (item.msg.role === 'assistant') {
      for (const call of item.msg.toolCalls ?? []) seenToolCalls.add(call.id);
      return true;
    }
    if (item.msg.role !== 'tool') return true;
    return Boolean(item.msg.toolCallId && seenToolCalls.has(item.msg.toolCallId));
  });
}

/**
 * 社区适配策略：先把普通消息裁剪交给 LangChain 消息抽象和 trimMessages，
 * 再回到 RunForge 的安全边界修正 tool 配对与锚点保留。默认不开启。
 */
class LangChainTrimContextCompactor extends CurrentContextCompactor {
  readonly name = 'langchain-trim' as const;

  override async compact(input: ContextCompactionInput): Promise<ContextCompactionOutput | null> {
    const { contextBudget, compactWarnRatio, compactHardRatio, keepRecentMessages, contextBudgetSource, modelContextWindow } =
      config.agent;
    const items = [...input.items];
    const estBefore = estimateTokens(messagesOf(items), input.tokensPerChar);

    if (estBefore < contextBudget * compactWarnRatio) {
      const forced = maskForcedToolCallPayloads(items, input.forceMaskedToolNames);
      const sentChars = totalChars(messagesOf(items));
      if (forced.masked) {
        return {
          items,
          sentChars,
          info: { estBefore, estAfter: estimateTokens(messagesOf(items), input.tokensPerChar), masked: forced.masked, summarized: 0, dropped: 0, reason: 'display-payload' },
          collapsedIds: forced.collapsedIds,
          summarizedIds: [],
        };
      }
      return null;
    }

    const { collapsedIds, masked } = maskPayloads(items, keepRecentMessages, input.forceMaskedToolNames);
    const summarizedIds: number[] = [];
    let summarized = 0;
    let l3Summary: LlmMessage | undefined;
    if (input.provider && estimateTokens(messagesOf(items), input.tokensPerChar) >= contextBudget * compactHardRatio) {
      const candidate = summaryCandidate(messagesOf(items), { keepRecent: keepRecentMessages });
      if (candidate) {
        const ids = dbIds(items.slice(candidate.start, candidate.end));
        if (ids.length) {
          const summary = await input.provider.complete(renderSummaryPrompt(candidate.messages, input.goalContent), []);
          l3Summary = summaryMessage(summary.content || 'Earlier context was summarized, but the model returned an empty summary.\n较早上下文已被摘要，但模型返回了空摘要。');
          items.splice(candidate.start, candidate.end - candidate.start, { msg: l3Summary, dbId: null });
          summarizedIds.push(...ids);
          summarized = ids.length;
        }
      }
    }

    if (estimateTokens(messagesOf(items), input.tokensPerChar) < contextBudget * compactHardRatio) {
      return {
        items,
        sentChars: totalChars(messagesOf(items)),
        info: {
          estBefore,
          estAfter: estimateTokens(messagesOf(items), input.tokensPerChar),
          masked,
          summarized,
          dropped: 0,
          reason: `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=langchain-trim`,
        },
        collapsedIds,
        summarizedIds,
        summaryMessage: l3Summary,
      };
    }

    const prefixEnd = protectedPrefixEnd(items);
    const prefix = items.slice(0, prefixEnd);
    const body = items.slice(prefixEnd);
    if (!body.length) {
      return {
        items,
        sentChars: totalChars(messagesOf(items)),
        info: { estBefore, estAfter: estimateTokens(messagesOf(items), input.tokensPerChar), masked, summarized, dropped: 0, reason: `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=langchain-trim` },
        collapsedIds,
        summarizedIds,
        summaryMessage: l3Summary,
      };
    }

    try {
      const langMessages = body.map((item, index) => toLangChainMessage(item.msg, String(item.dbId ?? `volatile-${index}`)));
      const trimmed = await trimMessages(langMessages, {
        maxTokens: Math.max(1, Math.floor(contextBudget * compactHardRatio) - estimateTokens(messagesOf(prefix), input.tokensPerChar)),
        tokenCounter: langChainTokenCounter(input.tokensPerChar),
        strategy: 'last',
        allowPartial: false,
      });
      const keptIds = new Set(trimmed.map((message) => message.id).filter((id): id is string => typeof id === 'string'));
      const trimmedItems = repairToolPairs([...prefix, ...body.filter((item, index) => keptIds.has(String(item.dbId ?? `volatile-${index}`)))]);
      const dropped = items.length - trimmedItems.length;
      if (dropped <= 0) {
        return {
          items,
          sentChars: totalChars(messagesOf(items)),
          info: { estBefore, estAfter: estimateTokens(messagesOf(items), input.tokensPerChar), masked, summarized, dropped: 0, reason: `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=langchain-trim` },
          collapsedIds,
          summarizedIds,
          summaryMessage: l3Summary,
        };
      }
      return {
        items: trimmedItems,
        sentChars: totalChars(messagesOf(trimmedItems)),
        info: {
          estBefore,
          estAfter: estimateTokens(messagesOf(trimmedItems), input.tokensPerChar),
          masked,
          summarized,
          dropped,
          reason: `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=langchain-trim`,
        },
        collapsedIds,
        summarizedIds,
        summaryMessage: l3Summary,
      };
    } catch {
      const m2 = slidingWindow(messagesOf(items), { keepRecent: keepRecentMessages });
      const kept = new Set(m2.messages);
      const fallbackItems = items.filter((it) => kept.has(it.msg));
      return {
        items: fallbackItems,
        sentChars: totalChars(messagesOf(fallbackItems)),
        info: {
          estBefore,
          estAfter: estimateTokens(messagesOf(fallbackItems), input.tokensPerChar),
          masked,
          summarized,
          dropped: items.length - fallbackItems.length,
          reason: `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=langchain-trim-fallback`,
        },
        collapsedIds,
        summarizedIds,
        summaryMessage: l3Summary,
      };
    }
  }
}

export function createContextCompactor(): ContextCompactor {
  return config.agent.contextStrategy === 'langchain-trim'
    ? new LangChainTrimContextCompactor()
    : new CurrentContextCompactor();
}
