// Provider-neutral LLM types. Each provider translates these to/from its own wire format.
import type { FinishReason } from '@runforge/contracts';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  /** Provider-specific call id, echoed back with the tool result */
  id: string;
  name: string;
  /** Raw JSON string of arguments */
  arguments: string;
}

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; path: string; name?: string };

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  /** 用户消息的派生多模态内容；只在调模型前生成，不落库。 */
  contentParts?: LlmContentPart[];
  /** assistant turns only */
  toolCalls?: LlmToolCall[];
  /** tool turns only — links the result to a prior tool call */
  toolCallId?: string;
  /** Set by context compaction: 'masked' = tool output or old tool-call args
   *  elided to a placeholder, 'summarized' = folded into a summary message. */
  collapsed?: 'masked' | 'summarized';
}

/** Neutral tool definition. parameters is a JSON Schema object. */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface LlmResult {
  content: string | null;
  /** Chain-of-thought / thinking text, when the model exposes it (deepseek, o-series, claude thinking) */
  reasoning?: string | null;
  toolCalls: LlmToolCall[];
  usage?: LlmUsage;
  /** 模型结束原因；用于区分正常 stop 和 max tokens 截断等非正常完成。 */
  finishReason?: FinishReason;
  /** 上游供应商原始结束原因，便于排查兼容层映射问题。 */
  rawFinishReason?: string;
}

/** Settings a provider needs. Kept small so providers stay easy to unit test. */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
}

/** Incremental chunk during streaming. */
export interface LlmDelta {
  content?: string;
  reasoning?: string;
  toolInputStart?: { id: string; name: string };
  toolInputDelta?: { id: string; name?: string; delta: string };
  toolInputAvailable?: { id: string; name: string; input: unknown };
}

/** A pluggable LLM backend. */
export interface Provider {
  readonly name: string;
  complete(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmResult>;
  /**
   * Optional streaming variant. Calls onDelta as tokens arrive and resolves with
   * the fully-aggregated result. Providers without this fall back to complete().
   */
  completeStream?(
    messages: LlmMessage[],
    tools: LlmTool[],
    onDelta: (delta: LlmDelta) => void,
  ): Promise<LlmResult>;
}
