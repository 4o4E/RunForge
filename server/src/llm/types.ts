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

/** Provider 返回的推理状态。正文只用于可读摘要，providerOptions 中可能携带
 *  OpenAI encrypted_content；应用不解密，只负责原样持久化和回放。 */
export type LlmJsonValue = null | string | number | boolean | LlmJsonValue[] | LlmJsonObject;
export interface LlmJsonObject { [key: string]: LlmJsonValue | undefined }

export interface LlmReasoningPart {
  text: string;
  providerOptions?: Record<string, LlmJsonObject>;
}

export interface LlmProviderState {
  reasoningParts?: LlmReasoningPart[];
  textProviderOptions?: Record<string, LlmJsonObject>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  /** 用户消息的派生多模态内容；只在调模型前生成，不落库。 */
  contentParts?: LlmContentPart[];
  /** assistant turns only */
  toolCalls?: LlmToolCall[];
  /** tool turns only — links the result to a prior tool call */
  toolCallId?: string;
  /** 供应商专用的可回放状态，不参与普通 UI 展示。 */
  providerState?: LlmProviderState;
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
  /** 需要进入下一轮并跨进程恢复的供应商推理状态。 */
  providerState?: LlmProviderState;
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
  /** 仅用于必须显式声明 max_tokens 的协议，值取模型目录声明的最大输出长度。 */
  maxOutputTokens: number | null;
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

/** 单次 Provider 请求的传输依赖。Runner 通过这里注入 observing fetch；
 * Provider adapter 本身只负责一次协议转换和发送，不拥有重试状态。 */
export interface ProviderCallOptions {
  fetch?: typeof globalThis.fetch;
  abortSignal?: AbortSignal;
}

/** A pluggable LLM backend. */
export interface Provider {
  readonly name: string;
  /** 使用上游流式协议，将增量交给调用方，并返回聚合后的完整结果。 */
  completeStream(
    messages: LlmMessage[],
    tools: LlmTool[],
    onDelta: (delta: LlmDelta) => void,
    options?: ProviderCallOptions,
  ): Promise<LlmResult>;
}
