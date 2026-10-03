import { z } from 'zod';
import type { HistoryStep } from './history.js';
import type { AskUserAnswer } from './agent.js';

/** 返回按展示顺序连续完整的工具执行 step 游标；模型响应完成不代表工具执行完成。 */
export function completedHistoryThrough(steps: readonly HistoryStep[], initial = 0): number {
  return completedHistoryThroughStates(steps.map((step) => ({ idx: step.idx, complete: isHistoryStepComplete(step) })), initial);
}

export function isHistoryStepComplete(step: HistoryStep): boolean {
  if (!step.result) return false;
  return step.result.toolCalls.every((call) => step.toolResults.some((result) => result.toolCallId === call.id));
}

/** 从已排序的 step 完整性状态计算安全游标；编号空缺不代表存在需要补发的聚合。 */
export function completedHistoryThroughStates(
  steps: readonly { idx: number; complete: boolean }[],
  initial = 0,
): number {
  let completedThrough = initial;
  for (const step of steps) {
    if (step.idx <= completedThrough) continue;
    if (!step.complete) break;
    completedThrough = step.idx;
  }
  return completedThrough;
}

export function historyStepIndexForMessage(
  messageId: number,
  steps: readonly Pick<HistoryStep, 'idx' | 'assistantMessageId'>[],
): number | null {
  const nextAssistant = steps
    .filter((step) => step.assistantMessageId !== null && step.assistantMessageId > messageId)
    .sort((left, right) => left.assistantMessageId! - right.assistantMessageId!)[0];
  return nextAssistant?.idx ?? null;
}

export const runStatusSchema = z.enum(['pending', 'running', 'waiting_for_user', 'done', 'error', 'canceling', 'canceled']);
export const askUserModeSchema = z.enum(['single', 'multiple', 'text']);
export const planStatusSchema = z.enum(['todo', 'doing', 'done', 'failed']);
export const goalPhaseSchema = z.enum(['working', 'reporting', 'completed']);
export const goalStateSchema = z.object({
  intent: z.string(),
  phase: goalPhaseSchema,
  plan: z.array(z.object({ text: z.string(), status: planStatusSchema, autoComplete: z.boolean().optional() }).strict()),
  decisions: z.array(z.string()),
  next: z.string(),
}).strict();

export const stepUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
}).strict();

export const historyToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.json(),
  startedAt: z.string().optional(),
}).strict();

export const historyToolResultSchema = z.object({
  toolCallId: z.string(),
  content: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  durationMs: z.number().optional(),
}).strict();

export const historyStepResultSchema = z.object({
  reasoning: z.string().nullable(),
  output: z.string().nullable(),
  usage: stepUsageSchema.nullable(),
  streamStats: z.object({
    stage: z.enum(['llm_waiting', 'reasoning', 'output', 'tool_call', 'tool_running', 'tool_result', 'done', 'error']),
    updatedAt: z.string(),
    activeTool: z.object({ id: z.string(), name: z.string() }).optional(),
    totals: z.object({
      outputChars: z.number(), reasoningChars: z.number(), toolInputChars: z.number(),
      toolOutputChars: z.number(), totalChars: z.number(),
    }).strict(),
    rate: z.object({ charsPerSecond: z.number(), history: z.array(z.number()) }).strict(),
  }).strict().nullable(),
  finishReason: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']).nullable(),
  rawFinishReason: z.string().nullable(),
  startedAt: z.string().nullable(),
  reasoningStartedAt: z.string().nullable(),
  endedAt: z.string(),
  durationMs: z.number().nullable(),
  toolCalls: z.array(historyToolCallSchema),
}).strict();

export const historyStepSchema = z.object({
  id: z.string(),
  idx: z.number(),
  assistantMessageId: z.number().int().nullable(),
  result: historyStepResultSchema.nullable(),
  toolResults: z.array(historyToolResultSchema),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
}).strict().superRefine((step, context) => {
  if (step.result && step.assistantMessageId === null) {
    context.addIssue({ code: 'custom', message: '有聚合结果的 step 必须关联 assistant 消息索引', path: ['assistantMessageId'] });
  }
});

export const threadHistoryRunSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  parent_run_id: z.string().nullable(),
  status: runStatusSchema,
  input: z.string(),
  model_ref: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  goal_state: goalStateSchema.nullable(),
  pending_interaction: z.object({
    question: z.string(),
    mode: askUserModeSchema,
    options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional(), recommended: z.boolean().optional(), required: z.boolean().optional() }).strict()),
    allowCustom: z.boolean(),
    required: z.boolean(),
  }).strict().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  steps: z.array(historyStepSchema),
}).strict();

export const threadHistoryResponseSchema = z.object({
  thread: z.object({
    id: z.string(),
    space_id: z.string(),
    source_type: z.enum(['web', 'external']),
    source_caller_id: z.string().nullable(),
    source_ref: z.record(z.string(), z.unknown()),
    title: z.string().nullable(),
    fallback_title: z.string().nullable().optional(),
    active_run_id: z.string().nullable(),
    pinned_at: z.string().nullable(),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }).strict(),
  space: z.object({ id: z.string(), name: z.string(), mode: z.enum(['web', 'external']) }).strict(),
  readOnly: z.boolean(),
  runs: z.array(threadHistoryRunSchema),
  notices: z.array(z.object({
    id: z.number(),
    thread_id: z.string(),
    kind: z.string(),
    message: z.string(),
    title: z.string().nullable().optional(),
    linked_thread_id: z.string().nullable(),
    linked_run_id: z.string().nullable(),
    created_at: z.string(),
  }).strict()),
  context_messages: z.array(z.object({
    id: z.number(),
    run_id: z.string(),
    step_id: z.string().nullable(),
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    tool_calls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string().optional(), argumentChars: z.number() }).strict()),
    tool_call_id: z.string().nullable(),
    collapsed: z.enum(['masked', 'summarized']).nullable(),
    summary_of: z.array(z.number()),
    content_chars: z.number(),
    content: z.string().nullable().optional(),
    encrypted_reasoning_count: z.number().optional(),
    encrypted_reasoning_chars: z.number().optional(),
    created_at: z.string(),
  }).strict()),
  debug: z.boolean(),
}).strict();

export const askUserOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
  required: z.boolean().optional(),
});

export const askUserSpecSchema = z.object({
  question: z.string(),
  mode: askUserModeSchema,
  options: z.array(askUserOptionSchema),
  allowCustom: z.boolean(),
  required: z.boolean(),
});

export const askUserAnswerSchema = z.object({
  mode: askUserModeSchema,
  selected: z.array(askUserOptionSchema),
  customOptions: z.array(z.string()),
  text: z.string(),
  note: z.string(),
  usedRecommended: z.boolean(),
});

export function persistedAskUserAnswer(content: string): AskUserAnswer | null {
  const prefix = /^用户回答：\s*/u;
  if (!prefix.test(content)) return null;
  const text = content.replace(prefix, '');
  try {
    const parsed = askUserAnswerSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // 兼容旧版以纯文本保存的回答。
  }
  return { mode: 'text', selected: [], customOptions: [], text, note: '', usedRecommended: false };
}

const stepEvent = (type: string, fields: Record<string, z.ZodType> = {}) => z.object({ type: z.literal(type), step: z.number(), ...fields }).strict();
const eventTimes = { startedAt: z.string().optional(), endedAt: z.string().optional(), durationMs: z.number().optional() };
const requiredEventTimes = { startedAt: z.string(), endedAt: z.string(), durationMs: z.number() };
const streamStatsValueSchema = historyStepResultSchema.shape.streamStats.unwrap();
export const agentEventSchema = z.discriminatedUnion('type', [
  stepEvent('step_start'),
  stepEvent('stream_stats', streamStatsValueSchema.shape),
  stepEvent('usage_update', { inputTokens: z.number().optional(), outputTokens: z.number().optional(), cachedInputTokens: z.number().optional(), estContextTokens: z.number().optional(), contextBudget: z.number().optional() }),
  stepEvent('reasoning', { text: z.string(), ...eventTimes }),
  stepEvent('reasoning_timing', requiredEventTimes),
  stepEvent('llm_delta', { text: z.string() }),
  stepEvent('tool_call', { name: z.string(), args: z.json(), id: z.string(), startedAt: z.string().optional() }),
  stepEvent('tool_result', { id: z.string(), name: z.string(), result: z.string(), ...eventTimes }),
  stepEvent('skill_activated', { skillId: z.string(), name: z.string(), source: z.enum(['builtin', 'user', 'business']), root: z.string(), readonly: z.boolean(), hash: z.string() }),
  stepEvent('mcp_activated', { serverId: z.string(), label: z.string(), description: z.string(), toolNames: z.array(z.string()) }),
  stepEvent('subagent_started', { subagentRunId: z.string(), runtimeProfileId: z.string().nullable().optional(), modelRef: z.string().nullable().optional(), skillNames: z.array(z.string()), task: z.string(), startedAt: z.string() }),
  stepEvent('subagent_finished', { subagentRunId: z.string(), output: z.string(), inputTokens: z.number().optional(), outputTokens: z.number().optional(), ...requiredEventTimes }),
  stepEvent('subagent_failed', { subagentRunId: z.string(), error: z.string(), ...requiredEventTimes }),
  stepEvent('plan_update', { goal: goalStateSchema }),
  stepEvent('compaction', {
    occurredAt: z.string(), estBefore: z.number(), estAfter: z.number(), masked: z.number(), summarized: z.number(), dropped: z.number(),
    reason: z.string().optional(), summary: z.string().optional(),
    affected: z.array(z.object({ messageId: z.number(), action: z.enum(['masked', 'summarized', 'dropped']), role: z.enum(['system', 'user', 'assistant', 'tool']), toolCallIds: z.array(z.string()), toolNames: z.array(z.string()), originalChars: z.number(), replacement: z.string().optional() }).strict()),
  }),
  stepEvent('shell_session_opened', { sessionId: z.string(), backend: z.string(), workspaceRoot: z.string() }),
  stepEvent('shell_session_closed', { sessionId: z.string(), reason: z.string().optional() }),
  stepEvent('shell_lease_changed', { sessionId: z.string(), actor: z.enum(['agent', 'user', 'system']).nullable(), runId: z.string().nullable().optional() }),
  stepEvent('shell_command_started', { sessionId: z.string(), commandId: z.string(), command: z.string(), waitMode: z.enum(['foreground', 'background']), startedAt: z.string() }),
  stepEvent('shell_command_output', { sessionId: z.string(), commandId: z.string(), stream: z.enum(['stdout', 'stderr', 'system']), seq: z.number(), text: z.string() }),
  stepEvent('shell_command_timeout', { sessionId: z.string(), commandId: z.string(), soft: z.boolean(), runtimeMs: z.number(), message: z.string() }),
  stepEvent('shell_command_attention', { sessionId: z.string(), commandId: z.string(), attention: z.string(), message: z.string() }),
  stepEvent('shell_command_finished', { sessionId: z.string(), commandId: z.string(), status: z.enum(['succeeded', 'failed', 'killed', 'timed_out', 'orphaned']), exitCode: z.number().nullable().optional(), signal: z.string().nullable().optional(), durationMs: z.number().optional() }),
  stepEvent('shell_command_killed', { sessionId: z.string(), commandId: z.string(), signal: z.string(), reason: z.string().optional() }),
  stepEvent('user_question', { question: z.string(), toolCallId: z.string().optional(), spec: askUserSpecSchema.optional() }),
  stepEvent('user_answer', { answer: askUserAnswerSchema }),
  stepEvent('user_cancel', { reason: z.string().optional() }),
  stepEvent('external_input_applied', { inputId: z.string(), version: z.number() }),
  stepEvent('progress_stalled', { reason: z.string(), question: z.string().optional() }),
  stepEvent('recovery', { message: z.string() }),
  stepEvent('stream_retry', { provider: z.string(), message: z.string() }),
  stepEvent('media_downgrade', { modality: z.literal('image'), model: z.string(), reason: z.enum(['configured_unsupported', 'provider_rejected', 'preflight_rejected']), files: z.array(z.string()), details: z.array(z.string()).optional() }),
  stepEvent('final', { output: z.string(), finishReason: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']).optional(), rawFinishReason: z.string().optional() }),
  stepEvent('error', { message: z.string(), finishReason: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']).optional(), rawFinishReason: z.string().optional() }),
]);

export const liveStepSnapshotSchema = z.object({
  step: z.number(),
  events: z.array(agentEventSchema),
}).strict();

export const runSocketFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step_snapshot'), runId: z.string(), cursor: z.number().int().nonnegative(), completedThrough: z.number(), step: liveStepSnapshotSchema.nullable() }).strict(),
  z.object({ type: z.literal('step_completed'), runId: z.string(), step: historyStepSchema }).strict(),
  z.object({ type: z.literal('event'), runId: z.string(), cursor: z.number().int().nonnegative(), event: agentEventSchema }).strict(),
]);

export const runSocketSubscriptionSchema = z.object({
  runId: z.string().min(1),
  completedThrough: z.coerce.number().int().nonnegative().default(0),
}).strict();

export const toolSettingsSchema = z.object({
  sandbox: z.enum(['off', 'enforce']),
  sandboxBackend: z.enum(['auto', 'none', 'bwrap']),
  workspaceRoot: z.string(),
  shellEnabled: z.boolean(),
  shellUseHostPath: z.boolean(),
  shellPathMode: z.enum(['system', 'custom']),
  shellPath: z.string(),
  network: z.enum(['enabled', 'disabled']),
  shellDeny: z.array(z.string()),
  maxOutput: z.number(),
});

const recordSchema = z.record(z.string(), z.unknown());

export const datasourceInputSchema = z.object({
  name: z.string(),
  type: z.enum(['postgres', 'mysql', 'mongodb', 'hive']),
  status: z.enum(['active', 'disabled']).optional(),
  connection: recordSchema,
  adminConfig: recordSchema.optional(),
  poolConfig: recordSchema.optional(),
});

export const permissionProfileInputSchema = z.object({
  name: z.string(),
  mode: z.enum(['readonly', 'limited_write', 'custom']),
  templateRole: z.string().optional(),
  grants: recordSchema.optional(),
  poolConfig: recordSchema.optional(),
});
