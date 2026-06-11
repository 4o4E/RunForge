import type { LlmConfig, LlmDelta, LlmMessage, LlmResult, LlmTool, Provider } from '../types.js';
import { postJson, streamPost } from '../http.js';

// --- OpenAI Chat Completions (legacy/compatible: POST /v1/chat/completions) ---
// For OpenAI-compatible vendors that don't speak the Responses API
// (DeepSeek, Moonshot, vLLM, Ollama, ...).

export function buildChatRequest(messages: LlmMessage[], tools: LlmTool[], model: string) {
  return {
    model,
    messages: messages.map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      return { role: m.role, content: m.content };
    }),
    tools: tools.length
      ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    temperature: 0.2,
  };
}

interface ChatData {
  choices?: {
    message?: {
      content?: string | null;
      // deepseek / some gateways expose chain-of-thought here
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parseChatResponse(data: ChatData): LlmResult {
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? null,
    reasoning: msg?.reasoning_content ?? msg?.reasoning ?? null,
    toolCalls: (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
  };
}

// Streaming delta shape (chat.completion.chunk).
interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

/** Pure: fold one streamed chunk into accumulators, returning the user-visible delta. */
export function applyStreamChunk(
  chunk: StreamChunk,
  acc: { content: string; reasoning: string; toolCalls: { id: string; name: string; arguments: string }[] },
): LlmDelta {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return {};
  const out: LlmDelta = {};
  if (delta.content) {
    acc.content += delta.content;
    out.content = delta.content;
  }
  const r = delta.reasoning_content ?? delta.reasoning;
  if (r) {
    acc.reasoning += r;
    out.reasoning = r;
  }
  for (const tc of delta.tool_calls ?? []) {
    const slot = (acc.toolCalls[tc.index] ??= { id: '', name: '', arguments: '' });
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
  }
  return out;
}

export function createOpenAIChatProvider(cfg: LlmConfig): Provider {
  const url = `${cfg.baseUrl}/chat/completions`;
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };
  return {
    name: 'openai-chat',
    async complete(messages, tools) {
      const data = await postJson(url, auth, buildChatRequest(messages, tools, cfg.model), {
        timeoutMs: cfg.timeoutMs,
        retries: cfg.retries,
      });
      return parseChatResponse(data as ChatData);
    },
    async completeStream(messages, tools, onDelta) {
      const acc = { content: '', reasoning: '', toolCalls: [] as { id: string; name: string; arguments: string }[] };
      await streamPost(
        url,
        auth,
        { ...buildChatRequest(messages, tools, cfg.model), stream: true },
        cfg.timeoutMs,
        (data) => {
          if (data === '[DONE]') return;
          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(data) as StreamChunk;
          } catch {
            return;
          }
          const d = applyStreamChunk(chunk, acc);
          if (d.content || d.reasoning) onDelta(d);
        },
      );
      return {
        content: acc.content || null,
        reasoning: acc.reasoning || null,
        toolCalls: acc.toolCalls.filter((t) => t.name),
      };
    },
  };
}
