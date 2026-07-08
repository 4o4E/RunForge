// 传输边界：UI 层只依赖 UiEvent 和 UiTransport，不依赖具体线协议。
// 切换 WS、SSE 或未来事件流时，不应该改渲染层代码。

/** 用户提交的一轮输入；保留对象形态，便于后续增加附件等字段。 */
export interface UserInput {
  text: string;
  modelRef?: string;
}

/**
 * 渲染层消费的标准化 UI 事件，和底层线协议无关。
 *
 * step 会保留，因为 agent 引擎是多步骤的，UI 也按 step 分组。
 * tool 事件可携带 input 或 output，渲染层按 id 合并。
 */
export type UiEvent =
  | { kind: 'step_start'; step: number }
  | { kind: 'stream_stats'; step: number; stats: StreamStats }
  | { kind: 'usage_update'; step: number; usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; estContextTokens?: number; contextBudget?: number } }
  | { kind: 'reasoning'; step: number; delta: string; startedAt?: string; endedAt?: string; durationMs?: number }
  | { kind: 'reasoning_timing'; step: number; startedAt: string; endedAt: string; durationMs: number }
  | { kind: 'text'; step: number; delta: string }
  | { kind: 'tool'; step: number; id: string; name: string; input?: unknown; output?: unknown; startedAt?: string; endedAt?: string; durationMs?: number }
  | { kind: 'plan_update'; step: number; goal: GoalState }
  | { kind: 'notice'; step: number; message: string }
  | { kind: 'ask_user_question'; step: number; runId?: string; spec: AskUserSpec }
  | { kind: 'ask_user_answer'; step: number; answer: AskUserAnswer }
  | { kind: 'ask_user_cancel'; step: number; reason?: string }
  | { kind: 'final'; step: number; output: string; finishReason?: FinishReason; rawFinishReason?: string }
  | { kind: 'error'; step: number; message: string; finishReason?: FinishReason; rawFinishReason?: string };

/**
 * run 启动和流式订阅的抽象。上层只调用 send 和 subscribe，
 * 不直接接触底层 REST/WS 调用。
 */
export interface UiTransport {
  /** 在指定 threadId 上用 input 启动 run，并返回新的 run id。 */
  send(threadId: string, input: UserInput): Promise<{ runId: string }>;
  /** 订阅 run 的实时 UiEvent，并返回取消订阅函数。 */
  subscribe(runId: string, onEvent: (e: UiEvent) => void, onClose?: () => void): () => void;
}
import type { AskUserAnswer, AskUserSpec, FinishReason, GoalState } from '@/api';
import type { StreamStats } from '@/api';
