import type { LlmConfig, LlmMessage, LlmResult, LlmTool, Provider } from '../types.js';
import { postJson } from '../http.js';

// --- Anthropic Messages API (POST /v1/messages) ---
// system is a top-level field; tool calls are `tool_use` content blocks and
// tool results are `tool_result` blocks inside a user message.

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function userBlocks(m: LlmMessage): Block[] {
  if (!m.contentParts?.length) return [{ type: 'text', text: m.content ?? '' }];
  return m.contentParts.map((part) => (
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }
  ));
}

export function buildAnthropicRequest(
  messages: LlmMessage[],
  tools: LlmTool[],
  cfg: Pick<LlmConfig, 'model' | 'maxTokens'>,
) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .join('\n\n');

  const apiMessages: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      apiMessages.push({ role: 'user', content: userBlocks(m) });
    } else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeParse(tc.arguments) });
      }
      apiMessages.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const block: Block = { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content ?? '' };
      // Merge consecutive tool results into the trailing user message.
      const last = apiMessages[apiMessages.length - 1];
      if (last && last.role === 'user') last.content.push(block);
      else apiMessages.push({ role: 'user', content: [block] });
    }
  }

  return {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: system || undefined,
    messages: apiMessages,
    tools: tools.length
      ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      : undefined,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

interface AnthropicData {
  content?: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseAnthropicResponse(data: AnthropicData): LlmResult {
  let content: string | null = null;
  let reasoning: string | null = null;
  const toolCalls: LlmResult['toolCalls'] = [];
  for (const block of data.content ?? []) {
    if (block.type === 'text' && block.text) content = (content ?? '') + block.text;
    else if (block.type === 'thinking' && block.thinking) reasoning = (reasoning ?? '') + block.thinking;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id ?? '', name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return {
    content,
    reasoning,
    toolCalls,
    usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
  };
}

export function createAnthropicProvider(cfg: LlmConfig): Provider {
  const baseUrl = cfg.baseUrl.includes('anthropic') ? cfg.baseUrl : 'https://api.anthropic.com/v1';
  return {
    name: 'anthropic',
    async complete(messages, tools) {
      const data = await postJson(
        `${baseUrl}/messages`,
        { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        buildAnthropicRequest(messages, tools, cfg),
        { timeoutMs: cfg.timeoutMs, retries: cfg.retries },
      );
      return parseAnthropicResponse(data as AnthropicData);
    },
  };
}
