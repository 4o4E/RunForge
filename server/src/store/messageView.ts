import type { ThreadMessage } from './types.js';

function isL3SummaryMessage(message: ThreadMessage): boolean {
  return message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('L3 锚定摘要：');
}

function dropOrphanToolResults(messages: ThreadMessage[]): ThreadMessage[] {
  const seenToolCalls = new Set<string>();
  return messages.filter((message) => {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) seenToolCalls.add(call.id);
      return true;
    }
    if (message.role !== 'tool') return true;
    return Boolean(message.toolCallId && seenToolCalls.has(message.toolCallId));
  });
}

/** 生成 LLM 可接受的历史视图：摘要进 system 前缀，工具结果必须有父 tool_call。 */
export function sanitizeThreadMessagesForModel(messages: ThreadMessage[]): ThreadMessage[] {
  const summaries: ThreadMessage[] = [];
  const regular: ThreadMessage[] = [];
  for (const message of messages) {
    if (isL3SummaryMessage(message)) summaries.push(message);
    else regular.push(message);
  }
  return dropOrphanToolResults([...summaries, ...regular]);
}
