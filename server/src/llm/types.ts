// Provider-neutral LLM types. Each provider translates these to/from its own wire format.

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  /** Provider-specific call id, echoed back with the tool result */
  id: string;
  name: string;
  /** Raw JSON string of arguments */
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  /** assistant turns only */
  toolCalls?: LlmToolCall[];
  /** tool turns only — links the result to a prior tool call */
  toolCallId?: string;
  /** Set by context compaction: 'masked' = tool output elided to a placeholder,
   *  'summarized' = folded into a summary message. Prevents re-compacting. */
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
}

export interface LlmResult {
  content: string | null;
  /** Chain-of-thought / thinking text, when the model exposes it (deepseek, o-series, claude thinking) */
  reasoning?: string | null;
  toolCalls: LlmToolCall[];
  usage?: LlmUsage;
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
