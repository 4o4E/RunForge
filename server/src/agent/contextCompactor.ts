import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  trimMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import { config } from '../config.js';
import type { AgentContextSettings } from '../config.js';
import type { LlmMessage } from '../llm/types.js';
import type { Provider } from '../llm/types.js';
import type { CompactionAffectedMessage } from '@runforge/contracts';
import {
  estimateTokens,
  maskOldAssistantToolCalls,
  maskOldToolResults,
  maskPlaceholder,
  maskToolCallArguments,
  renderSummaryPrompt,
  slidingWindow,
  summaryCandidate,
  summaryMessage,
  totalChars,
} from './compaction.js';

export interface WorkingMessage {
  msg: LlmMessage;
  dbId: number | null;
  /** 运行期间重新注入的 Skill 说明，不对应 messages 表中的记录。 */
  synthetic?: 'active-skill';
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
  /** 摘要覆盖的原始消息；近期工具轮次保留配对占位时与 summarizedIds 不同。 */
  summaryOfIds?: number[];
  summaryMessage?: LlmMessage;
  affected: CompactionAffectedMessage[];
}

export interface ContextCompactionInput {
  items: WorkingMessage[];
  goalContent: string;
  tokensPerChar: number;
  provider?: Provider;
  forceMaskedToolNames: string[];
  contextSettings: AgentContextSettings;
}

export interface ContextCompactionOutput extends Omit<CompactionResult, 'affected'> {
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

function summaryWithGoal(summary: string, goalContent: string): LlmMessage {
  const goal = goalContent.trim();
  const body = summary.trim() || 'Earlier context was summarized, but the model returned an empty summary.\n较早上下文已被摘要，但模型返回了空摘要。';
  return summaryMessage(goal ? `最新 Goal 状态:\n${goal}\n\n较早上下文摘要:\n${body}` : body);
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

/** 最近一轮工具结果只有在全部返回后才能整体摘要，避免留下悬空的调用或结果。 */
function latestCompleteToolRound(items: WorkingMessage[]): { start: number; end: number } | null {
  const end = items.length;
  let firstResult = end;
  while (firstResult > 0 && items[firstResult - 1]?.msg.role === 'tool') firstResult -= 1;
  if (firstResult === end || firstResult === 0) return null;
  const assistant = items[firstResult - 1]?.msg;
  if (assistant?.role !== 'assistant' || !assistant.toolCalls?.length) return null;
  const expected = new Set(assistant.toolCalls.map((call) => call.id));
  const actual = items.slice(firstResult, end).map((item) => item.msg.toolCallId);
  if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some((id) => !id || !expected.has(id))) return null;
  return { start: firstResult - 1, end };
}

/** 摘要输入保留每条结果的完整性与分段编号；摘要请求的切分不等于原文件截断。 */
export function segmentToolRoundForSummary(messages: LlmMessage[], maxChars: number): { chunks: string[]; completeness: string } {
  const calls = new Map(messages[0]?.toolCalls?.map((call) => [call.id, call]) ?? []);
  const blocks: string[] = [];
  const statuses: string[] = [];
  for (const call of messages[0]?.toolCalls ?? []) {
    if (call.arguments.length <= 300) continue;
    const label = `工具 ${call.name} 的原始调用参数`;
    const partSize = Math.max(256, maxChars - label.length - 100);
    const count = Math.ceil(call.arguments.length / partSize);
    for (let index = 0; index < count; index++) {
      blocks.push(`${label}\n摘要输入第 ${index + 1}/${count} 段（分段不是参数截断）：\n${call.arguments.slice(index * partSize, (index + 1) * partSize)}`);
    }
  }
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const call = calls.get(message.toolCallId ?? '');
    const media = message.mediaRefs?.map((ref) => `${ref.name ?? ref.path}（${ref.mimeType}）`).join('、');
    const truncated = (message.content ?? '').includes('…[工具策略已截断') || (message.content ?? '').includes('（内容已截断；');
    const args = call?.arguments ?? '{}';
    const label = `工具 ${call?.name ?? '未知'}，参数 ${args.length > 300 ? `${args.slice(0, 300)}…（参数共 ${args.length} 字符）` : args}，原始结果${truncated ? '已截断' : '完整'}`;
    statuses.push(label);
    const body = `${message.content ?? ''}${media ? `\n媒体引用：${media}` : ''}`;
    const partSize = Math.max(256, maxChars - label.length - 100);
    const count = Math.max(1, Math.ceil(body.length / partSize));
    for (let index = 0; index < count; index++) {
      blocks.push(`${label}\n摘要输入第 ${index + 1}/${count} 段（此处分段不是原始结果截断）：\n${body.slice(index * partSize, (index + 1) * partSize)}`);
    }
  }
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n\n' : ''}${block}`;
  }
  if (current) chunks.push(current);
  return { chunks, completeness: statuses.join('；') };
}

async function summarizeRecentToolRound(
  messages: LlmMessage[], goal: string, provider: Provider, contextBudget: number,
): Promise<string> {
  const maxChars = Math.max(512, Math.floor(contextBudget * 0.6));
  const finalSummaryChars = Math.min(6000, Math.max(1500, Math.floor(contextBudget * 0.3)));
  const { chunks, completeness } = segmentToolRoundForSummary(messages, maxChars);
  const summarizeChunk = async (text: string, stage: string): Promise<string> => {
    const limit = stage.startsWith('原始记录') ? Math.min(1400, Math.ceil(finalSummaryChars / 4)) : finalSummaryChars;
    const result = await provider.completeStream([
      { role: 'system', content: `请准确压缩已完成工具调用的实际结果，最多 ${limit} 字。按文件或工具结果分别保留关键事实、路径、读取范围和真正的不确定之处。摘要输入分段不是源文件截断，不得依据片段边界推断文件不完整。原始结果的完整性以此清单为准：${completeness}。当前任务需要依据这些结果继续完成。` },
      { role: 'user', content: `当前目标：${goal}\n${stage}\n${text}` },
    ], [], () => {});
    const summary = result.content?.trim();
    if (!summary) throw new Error('上下文超预算，工具轮次摘要没有返回文字');
    return summary;
  };
  let parts: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    parts.push(await summarizeChunk(chunk, `原始记录第 ${index + 1}/${chunks.length} 段：`));
  }
  // 大量并列工具结果先分段摘要，再逐层合并；每次摘要请求仍受同一字符上限约束。
  for (let level = 0; parts.length > 1; level += 1) {
    if (level >= 8) throw new Error('上下文超预算，工具轮次摘要未能收敛');
    const combined = parts.join('\n\n');
    const next: string[] = [];
    for (let start = 0; start < combined.length; start += maxChars) {
      next.push(await summarizeChunk(combined.slice(start, start + maxChars), '已压缩片段合并：'));
    }
    if (next.length >= parts.length) throw new Error('上下文超预算，工具轮次摘要未缩短');
    parts = next;
  }
  return parts[0] ?? '';
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
    const { contextBudget, contextBudgetSource, modelContextWindow } = input.contextSettings;
    const { keepRecentMessages } = config.agent;
    const items = [...input.items];
    const estBefore = estimateTokens(messagesOf(items), input.tokensPerChar);

    if (estBefore < contextBudget) {
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
    let summaryOfIds: number[] | undefined;
    let summarized = 0;
    let dropped = 0;
    const reason = `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=current`;

    const { collapsedIds, masked: initiallyMasked } = maskPayloads(items, keepRecentMessages, input.forceMaskedToolNames);
    let masked = initiallyMasked;

    let l3Summary: LlmMessage | undefined;
    if (input.provider && estimateTokens(messagesOf(items), input.tokensPerChar) >= contextBudget) {
      const candidate = summaryCandidate(messagesOf(items), { keepRecent: keepRecentMessages });
      if (candidate) {
        const ids = dbIds(items.slice(candidate.start, candidate.end));
        if (ids.length) {
          const summary = await input.provider.completeStream(
            renderSummaryPrompt(candidate.messages, input.goalContent),
            [],
            () => {},
          );
          l3Summary = summaryWithGoal(summary.content ?? '', input.goalContent);
          items.splice(candidate.start, candidate.end - candidate.start, { msg: l3Summary, dbId: null });
          summarizedIds.push(...ids);
          summarized = ids.length;
        }
      }
    }

    if (estimateTokens(messagesOf(items), input.tokensPerChar) >= contextBudget) {
      const m2 = slidingWindow(messagesOf(items), { keepRecent: keepRecentMessages });
      if (m2.dropped > 0) {
        const kept = new Set(m2.messages);
        const before = items.length;
        const keptItems = items.filter((it) => kept.has(it.msg));
        items.splice(0, items.length, ...keptItems);
        dropped = before - items.length;
      }
    }

    // 旧历史处理完仍超预算时，保留最近完整工具轮次的配对占位并补充摘要。
    // 一次只压缩一轮，让 executor 先持久化摘要，再决定是否还需要下一次压缩。
    if (!l3Summary && input.provider && estimateTokens(messagesOf(items), input.tokensPerChar) >= contextBudget) {
      const recent = latestCompleteToolRound(items);
      if (recent) {
        const original = items.slice(recent.start, recent.end);
        const ids = dbIds(original);
        if (ids.length === original.length) {
          const body = await summarizeRecentToolRound(
            original.map((item) => item.msg), input.goalContent, input.provider, contextBudget,
          );
          l3Summary = summaryWithGoal(`最近完整工具轮次摘要：\n${body}`, input.goalContent);
          // 模型需要看见 file_read 等调用已经完成；成对占位与摘要同时保留。
          // 原始正文只在派生视图缩短，重启后由 collapsed=masked 恢复同样的配对。
          for (const item of original) {
            item.msg = item.msg.role === 'tool'
              ? { ...item.msg, content: maskPlaceholder(item.msg.content ?? ''), mediaRefs: [], contentParts: undefined, collapsed: 'masked' }
              : { ...item.msg, toolCalls: maskToolCallArguments(item.msg.toolCalls ?? []).calls, providerState: undefined, collapsed: 'masked' };
            collapsedIds.push(item.dbId as number);
          }
          masked += ids.length;
          items.splice(recent.end, 0, { msg: l3Summary, dbId: null });
          summaryOfIds = ids;
          summarized = ids.length;
        }
      }
    }

    const sentChars = totalChars(messagesOf(items));
    return {
      items,
      sentChars,
      info: { estBefore, estAfter: estimateTokens(messagesOf(items), input.tokensPerChar), masked, summarized, dropped, reason },
      collapsedIds,
      summarizedIds,
      summaryOfIds,
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
  while (
    i < items.length
    && items[i].msg.role === 'system'
    && items[i].msg.collapsed !== 'summarized'
  ) i += 1;
  return i;
}

function protectedContext(items: WorkingMessage[]): { prefix: WorkingMessage[]; body: WorkingMessage[] } {
  const sysEnd = leadingSystemEnd(items);
  let summaryIndex = -1;
  for (let index = sysEnd; index < items.length; index += 1) {
    const message = items[index].msg;
    if (message.role === 'system' && message.collapsed === 'summarized') summaryIndex = index;
  }
  if (summaryIndex >= 0) {
    return {
      prefix: [...items.slice(0, sysEnd), items[summaryIndex]],
      body: items.slice(summaryIndex + 1),
    };
  }
  const firstUserIdx = items.findIndex((item, i) => i >= sysEnd && item.msg.role === 'user');
  const prefixEnd = firstUserIdx >= 0 ? firstUserIdx + 1 : sysEnd;
  return { prefix: items.slice(0, prefixEnd), body: items.slice(prefixEnd) };
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
    const { contextBudget, contextBudgetSource, modelContextWindow } = input.contextSettings;
    const { keepRecentMessages } = config.agent;
    const items = [...input.items];
    const estBefore = estimateTokens(messagesOf(items), input.tokensPerChar);

    if (estBefore < contextBudget) {
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
    if (input.provider && estimateTokens(messagesOf(items), input.tokensPerChar) >= contextBudget) {
      const candidate = summaryCandidate(messagesOf(items), { keepRecent: keepRecentMessages });
      if (candidate) {
        const ids = dbIds(items.slice(candidate.start, candidate.end));
        if (ids.length) {
          const summary = await input.provider.completeStream(
            renderSummaryPrompt(candidate.messages, input.goalContent),
            [],
            () => {},
          );
          l3Summary = summaryWithGoal(summary.content ?? '', input.goalContent);
          items.splice(candidate.start, candidate.end - candidate.start, { msg: l3Summary, dbId: null });
          summarizedIds.push(...ids);
          summarized = ids.length;
        }
      }
    }

    if (estimateTokens(messagesOf(items), input.tokensPerChar) < contextBudget) {
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

    const { prefix, body } = protectedContext(items);
    if (!body.length) {
      const dropped = items.length - prefix.length;
      return {
        items: prefix,
        sentChars: totalChars(messagesOf(prefix)),
        info: { estBefore, estAfter: estimateTokens(messagesOf(prefix), input.tokensPerChar), masked, summarized, dropped, reason: `${contextBudgetSource}: budget=${contextBudget}, modelWindow=${modelContextWindow}, strategy=langchain-trim` },
        collapsedIds,
        summarizedIds,
        summaryMessage: l3Summary,
      };
    }

    try {
      const langMessages = body.map((item, index) => toLangChainMessage(item.msg, String(item.dbId ?? `volatile-${index}`)));
      const trimmed = await trimMessages(langMessages, {
        maxTokens: Math.max(1, contextBudget - estimateTokens(messagesOf(prefix), input.tokensPerChar)),
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
