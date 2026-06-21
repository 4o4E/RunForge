import type { LlmConfig, LlmMessage, LlmResult, LlmTool, Provider } from '../types.js';
import { postJson } from '../http.js';

// --- OpenAI Responses API (the "new protocol": POST /v1/responses) ---
// Tool defs are flat ({type:'function', name, ...}); tool calls come back as
// `function_call` output items and results are fed back as `function_call_output`.

interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: unknown[];
  tools?: { type: 'function'; name: string; description: string; parameters: Record<string, unknown> }[];
  tool_choice?: 'auto';
  max_output_tokens?: number;
}

function imageDataUrl(data: string, mimeType: string): string {
  return `data:${mimeType};base64,${data}`;
}

function responsesUserContent(m: LlmMessage): string | unknown[] {
  if (!m.contentParts?.length) return m.content ?? '';
  return m.contentParts.map((part) => (
    part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : { type: 'input_image', image_url: imageDataUrl(part.data, part.mimeType) }
  ));
}

/** Pure: translate neutral messages + tools into a Responses API request body. */
export function buildResponsesRequest(
  messages: LlmMessage[],
  tools: LlmTool[],
  cfg: Pick<LlmConfig, 'model' | 'maxTokens'>,
): ResponsesRequest {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .join('\n\n');

  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      input.push({ role: 'user', content: responsesUserContent(m) });
    } else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content ?? '' });
    }
  }

  return {
    model: cfg.model,
    instructions: instructions || undefined,
    input,
    tools: tools.length
      ? tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters }))
      : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    max_output_tokens: cfg.maxTokens,
  };
}

interface ResponsesData {
  output?: {
    type: string;
    role?: string;
    content?: { type: string; text?: string }[];
    summary?: { type: string; text?: string }[];
    call_id?: string;
    name?: string;
    arguments?: string;
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Pure: parse a Responses API response into a neutral result. */
export function parseResponsesOutput(data: ResponsesData): LlmResult {
  let content: string | null = null;
  let reasoning: string | null = null;
  const toolCalls: LlmResult['toolCalls'] = [];

  for (const item of data.output ?? []) {
    if (item.type === 'message') {
      const text = (item.content ?? [])
        .filter((c) => c.type === 'output_text' && c.text)
        .map((c) => c.text)
        .join('');
      if (text) content = (content ?? '') + text;
    } else if (item.type === 'reasoning') {
      // reasoning items expose human-readable summaries (when requested)
      const text = (item.summary ?? [])
        .filter((c) => c.type === 'summary_text' && c.text)
        .map((c) => c.text)
        .join('\n');
      if (text) reasoning = (reasoning ?? '') + text;
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id ?? '', name: item.name ?? '', arguments: item.arguments ?? '{}' });
    }
  }

  return {
    content,
    reasoning,
    toolCalls,
    usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
  };
}

export function createOpenAIResponsesProvider(cfg: LlmConfig): Provider {
  return {
    name: 'openai-responses',
    async complete(messages, tools) {
      const data = await postJson(
        `${cfg.baseUrl}/responses`,
        { Authorization: `Bearer ${cfg.apiKey}` },
        buildResponsesRequest(messages, tools, cfg),
        { timeoutMs: cfg.timeoutMs, retries: cfg.retries },
      );
      return parseResponsesOutput(data as ResponsesData);
    },
  };
}
