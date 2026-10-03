import type { AgentEvent, AskUserSpec, FinishReason, RunStatus, StreamStats } from './agent.js';
import type { GoalState } from './goal.js';
import type { Thread, ThreadContextMessage, ThreadNotice } from './threads.js';

export interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** 普通聊天历史只包含展示 step 响应所需字段，不包含请求快照或运行时协议状态。 */
export interface HistoryToolCall {
  id: string;
  name: string;
  args: unknown;
  startedAt?: string;
}

export interface HistoryToolResult {
  toolCallId: string;
  content: string;
  createdAt: string;
  startedAt?: string;
  durationMs?: number;
}

export interface HistoryStepResult {
  reasoning: string | null;
  output: string | null;
  usage: StepUsage | null;
  streamStats: StreamStats | null;
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
  startedAt: string | null;
  reasoningStartedAt: string | null;
  endedAt: string;
  durationMs: number | null;
  toolCalls: HistoryToolCall[];
}

export interface HistoryStep {
  id: string;
  idx: number;
  assistantMessageId: number | null;
  result: HistoryStepResult | null;
  toolResults: HistoryToolResult[];
  createdAt: string;
  completedAt: string | null;
}

/** 只用于从历史聚合恢复对话边界，不会作为实时 AgentEvent 发布。 */
export interface HistoryUserMessageBoundary {
  type: 'history_user_message';
  step: number;
  messageId: number;
}

export type HistoryRunEvent = AgentEvent | HistoryUserMessageBoundary;

export interface ThreadHistoryRun {
  id: string;
  thread_id: string;
  parent_run_id: string | null;
  status: RunStatus;
  input: string;
  model_ref: string | null;
  output: string | null;
  error: string | null;
  goal_state: GoalState | null;
  pending_interaction: AskUserSpec | null;
  created_at: string;
  updated_at: string;
  steps: HistoryStep[];
}

export interface ThreadHistoryResponse {
  thread: Thread;
  space: { id: string; name: string; mode: 'web' | 'external' };
  readOnly: boolean;
  runs: ThreadHistoryRun[];
  notices: ThreadNotice[];
  context_messages: ThreadContextMessage[];
  debug: boolean;
}

export interface LiveStepSnapshot {
  step: number;
  events: AgentEvent[];
}

export type RunSocketFrame =
  | { type: 'step_snapshot'; runId: string; cursor: number; completedThrough: number; step: LiveStepSnapshot | null }
  | { type: 'step_completed'; runId: string; step: HistoryStep }
  | { type: 'event'; runId: string; cursor: number; event: AgentEvent };
