import type { LlmMessage } from '../llm/types.js';
import type { StepAggregate, StepToolResult } from './types.js';

/** 消息索引只规定顺序；模型响应与工具结果必须来自所属 step，不能读请求快照。 */
export function stepMessage(role: LlmMessage['role'], toolCallId: string | null | undefined, result: StepAggregate | null, tools: StepToolResult[]): LlmMessage | null {
  if (role === 'assistant') {
    if (!result) throw new Error('assistant 消息索引缺少 step 聚合响应');
    return { role, content: result.output, toolCalls: result.toolCalls.length ? result.toolCalls : undefined, providerState: result.providerState };
  }
  if (role === 'tool') {
    const output = tools.find((tool) => tool.toolCallId === toolCallId);
    if (!output) throw new Error(`工具结果索引缺少 step 执行结果：${toolCallId}`);
    return { role, content: output.content, toolCallId: output.toolCallId, mediaRefs: output.mediaRefs };
  }
  return null;
}
