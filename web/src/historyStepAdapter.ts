import type {
  AgentEvent,
  AskUserSpec,
  HistoryRunEvent,
  HistoryStep,
  ThreadContextMessage,
  ThreadHistoryRun,
} from '@runforge/contracts';
import { historyStepIndexForMessage, persistedAskUserAnswer } from '@runforge/contracts';

function parseCallArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function askUserSpecFromArgs(args: unknown): AskUserSpec | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const row = args as Record<string, unknown>;
  if (typeof row.question !== 'string' || !row.question.trim()) return null;
  const mode = row.mode === 'single' || row.mode === 'multiple' ? row.mode : 'text';
  const options = Array.isArray(row.options) ? row.options.flatMap((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
    const item = option as Record<string, unknown>;
    if (typeof item.label !== 'string') return [];
    return [{
      id: typeof item.id === 'string' ? item.id : item.label,
      label: item.label,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.recommended === 'boolean' ? { recommended: item.recommended } : {}),
      ...(typeof item.required === 'boolean' ? { required: item.required } : {}),
    }];
  }) : [];
  return { question: row.question, mode, options, allowCustom: row.allowCustom === true, required: row.required !== false };
}

/** 只把持久化 step 聚合投影为现有聊天渲染器使用的内部事件类型。 */
export function historyStepEvents(run: ThreadHistoryRun, userMessages: ThreadContextMessage[]): HistoryRunEvent[] {
  const events: HistoryRunEvent[] = [];
  const generatedUsers = userMessages
    .filter((message) => message.role === 'user')
    .slice(1)
    .sort((left, right) => left.id - right.id);
  const trailingBoundaries: HistoryRunEvent[] = [];
  const boundariesByStep = new Map<number, HistoryRunEvent[]>();
  const fallbackStep = run.steps.at(-1)?.idx ?? 0;
  for (const message of generatedUsers) {
    const nextStep = historyStepIndexForMessage(message.id, run.steps);
    const step = nextStep ?? fallbackStep;
    const previousStep = run.steps
      .filter((candidate) => candidate.assistantMessageId !== null && candidate.assistantMessageId < message.id)
      .sort((left, right) => right.assistantMessageId! - left.assistantMessageId!)[0];
    const answer = previousStep?.result?.toolCalls.some((call) => call.name === 'ask_user')
      ? persistedAskUserAnswer(message.content ?? '')
      : null;
    const boundary: HistoryRunEvent = answer
      ? { type: 'user_answer', step, answer }
      : { type: 'history_user_message', step, messageId: message.id };
    if (nextStep !== null) {
      const stepBoundaries = boundariesByStep.get(step) ?? [];
      stepBoundaries.push(boundary);
      boundariesByStep.set(step, stepBoundaries);
    } else {
      trailingBoundaries.push(boundary);
    }
  }
  for (const step of [...run.steps].sort((left, right) => left.idx - right.idx)) {
    events.push(...(boundariesByStep.get(step.idx) ?? []));
    events.push(...historyStepToEvents(step));
  }
  events.push(...trailingBoundaries);
  if (run.goal_state?.plan.length) events.push({ type: 'plan_update', step: run.steps.at(-1)?.idx ?? 0, goal: run.goal_state });
  if (run.pending_interaction && !events.some((event) => event.type === 'user_question' && event.step === run.steps.at(-1)?.idx && event.question === run.pending_interaction!.question)) {
    events.push({
      type: 'user_question', step: run.steps.at(-1)?.idx ?? 0,
      question: run.pending_interaction.question, spec: run.pending_interaction,
    });
  }
  if (run.status === 'done' && run.output) {
    events.push({ type: 'final', step: run.steps.at(-1)?.idx ?? 0, output: run.output, finishReason: 'stop' });
  } else if ((run.status === 'error' || run.status === 'canceled') && run.error) {
    events.push({ type: 'error', step: run.steps.at(-1)?.idx ?? 0, message: run.error });
  }
  return events;
}

export function historyStepToEvents(step: HistoryStep): AgentEvent[] {
  const result = step.result;
  if (!result) return [];
  const events: AgentEvent[] = [{ type: 'step_start', step: step.idx }];
  if (result.reasoning) {
    events.push({
      type: 'reasoning', step: step.idx, text: result.reasoning,
      ...((result.reasoningStartedAt ?? result.startedAt) ? { startedAt: result.reasoningStartedAt ?? result.startedAt! } : {}),
      endedAt: result.endedAt,
      ...(result.durationMs !== null ? { durationMs: result.durationMs } : {}),
    });
  }
  if (result.output) events.push({ type: 'llm_delta', step: step.idx, text: result.output });
  if (result.usage) events.push({ type: 'usage_update', step: step.idx, ...result.usage });
  if (result.streamStats) events.push({ type: 'stream_stats', step: step.idx, ...result.streamStats });
  const callById = new Map<string, { id: string; name: string }>();
  for (const call of result.toolCalls) {
    callById.set(call.id, call);
    const args = parseCallArguments(call.args);
    events.push({ type: 'tool_call', step: step.idx, id: call.id, name: call.name, args, ...(call.startedAt ? { startedAt: call.startedAt } : {}) });
    if (call.name === 'ask_user' && args && typeof args === 'object' && typeof (args as Record<string, unknown>).question === 'string') {
      const spec = askUserSpecFromArgs(args);
      events.push({
        type: 'user_question', step: step.idx,
        question: (args as Record<string, string>).question,
        ...(spec ? { spec, toolCallId: call.id } : {}),
      });
    }
  }
  for (const toolResult of step.toolResults) {
    const call = callById.get(toolResult.toolCallId);
    if (!call) continue;
    events.push({
      type: 'tool_result', step: step.idx, id: toolResult.toolCallId, name: call.name,
      result: toolResult.content,
      ...(toolResult.startedAt ? { startedAt: toolResult.startedAt } : {}),
      endedAt: toolResult.createdAt,
      ...(toolResult.durationMs !== undefined ? { durationMs: toolResult.durationMs } : {}),
    });
  }
  return events;
}
