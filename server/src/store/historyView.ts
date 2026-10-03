import type { HistoryStep } from '@runforge/contracts';
import type { HistoryStepRow } from './types.js';
import { redactToolArgs } from './runEventView.js';

function usageView(usage: NonNullable<HistoryStepRow['result']>['usage']) {
  if (!usage) return null;
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
  };
}

function streamStatsView(stats: NonNullable<HistoryStepRow['result']>['streamStats']) {
  if (!stats) return null;
  return {
    stage: stats.stage,
    updatedAt: stats.updatedAt,
    ...(stats.activeTool ? { activeTool: { id: stats.activeTool.id, name: stats.activeTool.name } } : {}),
    totals: {
      outputChars: stats.totals.outputChars,
      reasoningChars: stats.totals.reasoningChars,
      toolInputChars: stats.totals.toolInputChars,
      toolOutputChars: stats.totals.toolOutputChars,
      totalChars: stats.totals.totalChars,
    },
    rate: {
      charsPerSecond: stats.rate.charsPerSecond,
      history: stats.rate.history,
    },
  };
}

/** HTTP 和 WebSocket 只发送展示所需的聚合字段，不发送请求快照或协议状态。 */
export function historyStepView(step: HistoryStepRow): HistoryStep {
  const result = step.result;
  const resultByCall = new Map(step.tool_results.map((toolResult) => [toolResult.toolCallId, toolResult]));
  return {
    id: step.id,
    idx: step.idx,
    assistantMessageId: step.assistantMessageId,
    result: result ? {
      reasoning: result.reasoning,
      output: result.output,
      usage: usageView(result.usage),
      streamStats: streamStatsView(result.streamStats),
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      startedAt: result.startedAt,
      reasoningStartedAt: result.reasoningStartedAt,
      endedAt: result.endedAt,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls.map((call) => {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments) as unknown;
        } catch {
          args = call.arguments;
        }
        return {
          id: call.id,
          name: call.name,
          args: redactToolArgs(args),
          ...(resultByCall.get(call.id)?.startedAt ? { startedAt: resultByCall.get(call.id)!.startedAt } : {}),
        };
      }),
    } : null,
    toolResults: step.tool_results.map((toolResult) => ({
      toolCallId: toolResult.toolCallId,
      content: toolResult.content,
      createdAt: toolResult.createdAt,
      startedAt: toolResult.startedAt,
      durationMs: toolResult.durationMs,
    })),
    createdAt: step.created_at,
    completedAt: step.completed_at,
  };
}
