import type { AskUserSpec } from '../agent/types.js';
import { historyStepIndexForMessage, persistedAskUserAnswer } from '@runforge/contracts';
import type { HistoryRunEvent } from '@runforge/contracts';
import type { RawThreadMessage, RunRow, HistoryStepRow } from './types.js';

const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|key|credential|connectionurl)/i;

function redactShellCommand(command: string): string {
  return command
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY)[A-Z0-9_]*)=('[^']*'|"[^"]*"|[^\s;&|]+)/gi, '$1=[redacted]')
    .replace(/(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, '$1$2:[redacted]@')
    .replace(/(--password(?:=|\s+))('[^']*'|"[^"]*"|[^\s;&|]+)/gi, '$1[redacted]');
}

export function redactToolArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactToolArgs);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) out[key] = '[redacted]';
    else if (key === 'command' && typeof item === 'string') out[key] = redactShellCommand(item);
    else out[key] = redactToolArgs(item);
  }
  return out;
}

function toolArgs(value: string): unknown {
  try {
    return redactToolArgs(JSON.parse(value));
  } catch {
    return value;
  }
}

function askUserSpec(value: unknown): AskUserSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.question !== 'string' || !input.question.trim()) return null;
  const mode = input.mode === 'single' || input.mode === 'multiple' || input.mode === 'text' ? input.mode : 'text';
  const options = Array.isArray(input.options) ? input.options.flatMap((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
    const row = option as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.label !== 'string') return [];
    return [{
      id: row.id,
      label: row.label,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      ...(typeof row.recommended === 'boolean' ? { recommended: row.recommended } : {}),
      ...(typeof row.required === 'boolean' ? { required: row.required } : {}),
    }];
  }) : [];
  return {
    question: input.question.trim(),
    mode,
    options,
    allowCustom: input.allowCustom === true,
    required: input.required !== false,
  };
}

/** 从 step 聚合和消息索引派生历史展示；普通用户边界不属于实时 AgentEvent。 */
export function buildRunHistoryEvents(run: RunRow, steps: HistoryStepRow[], messages: RawThreadMessage[]): HistoryRunEvent[] {
  const events: HistoryRunEvent[] = [];
  const generatedUsers = messages.filter((message) => message.role === 'user').slice(1).sort((a, b) => a.id - b.id);
  const boundariesByStep = new Map<number, HistoryRunEvent[]>();
  const trailingBoundaries: HistoryRunEvent[] = [];
  for (const message of generatedUsers) {
    const nextStep = historyStepIndexForMessage(message.id, steps);
    const step = nextStep ?? steps.at(-1)?.idx ?? 0;
    const previousStep = [...steps]
      .filter((candidate) => candidate.assistantMessageId < message.id)
      .sort((left, right) => right.assistantMessageId - left.assistantMessageId)[0];
    const hasAskUser = previousStep?.result?.toolCalls.some((call) => call.name === 'ask_user') ?? false;
    const answer = hasAskUser ? persistedAskUserAnswer(message.content ?? '') : null;
    const boundary: HistoryRunEvent = answer
      ? { type: 'user_answer', step, answer }
      : { type: 'history_user_message', step, messageId: message.id };
    if (nextStep === null) trailingBoundaries.push(boundary);
    else boundariesByStep.set(step, [...(boundariesByStep.get(step) ?? []), boundary]);
  }

  for (const step of [...steps].sort((left, right) => left.idx - right.idx)) {
    events.push(...(boundariesByStep.get(step.idx) ?? []));
    const result = step.result;
    if (!result) continue;
    events.push({ type: 'step_start', step: step.idx });
    if (result.reasoning) {
      events.push({
        type: 'reasoning',
        step: step.idx,
        text: result.reasoning,
        startedAt: result.reasoningStartedAt ?? result.startedAt ?? undefined,
        endedAt: result.endedAt,
        durationMs: result.durationMs ?? undefined,
      });
    }
    if (result.output) events.push({ type: 'llm_delta', step: step.idx, text: result.output });
    if (result.usage) {
      events.push({
        type: 'usage_update',
        step: step.idx,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
      });
    }
    if (result.streamStats) events.push({ type: 'stream_stats', step: step.idx, ...result.streamStats });

    const toolNames = new Map<string, string>();
    for (const call of result.toolCalls) {
      toolNames.set(call.id, call.name);
      const args = toolArgs(call.arguments);
      events.push({
        type: 'tool_call', step: step.idx, id: call.id, name: call.name, args, startedAt: result.endedAt,
      });
      if (call.name === 'ask_user') {
        const spec = askUserSpec(args);
        if (spec) events.push({ type: 'user_question', step: step.idx, question: spec.question, toolCallId: call.id, spec });
      }
    }
    for (const output of step.tool_results) {
      const name = toolNames.get(output.toolCallId) ?? 'tool';
      events.push({
        type: 'tool_result',
        step: step.idx,
        id: output.toolCallId,
        name,
        result: output.content,
        startedAt: output.startedAt,
        endedAt: output.createdAt,
        durationMs: output.durationMs,
      });
    }
  }

  events.push(...trailingBoundaries);
  if (run.goal_state?.plan.length) events.push({ type: 'plan_update', step: steps.at(-1)?.idx ?? 0, goal: run.goal_state });
  if (run.pending_interaction && !events.some((event) => event.type === 'user_question' && event.step === steps.at(-1)?.idx && event.question === run.pending_interaction!.question)) {
    events.push({
      type: 'user_question',
      step: steps.at(-1)?.idx ?? 0,
      question: run.pending_interaction.question,
      spec: run.pending_interaction,
    });
  }
  if (run.status === 'done' && run.output) {
    events.push({ type: 'final', step: steps.at(-1)?.idx ?? 0, output: run.output, finishReason: 'stop' });
  } else if ((run.status === 'error' || run.status === 'canceled') && run.error) {
    events.push({ type: 'error', step: steps.at(-1)?.idx ?? 0, message: run.error });
  }
  return events;
}
