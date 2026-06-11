// AI SDK-backed provider (Phase 2). Implements the same neutral `Provider`
// contract the executor already depends on, but delegates protocol mapping,
// streaming, retries and tool-call assembly to the Vercel AI SDK. This replaces
// the hand-written openai-chat / openai-responses / anthropic wire translation.
//
// It is a *single-turn* provider: like the legacy providers, it returns the
// model's text + tool calls and lets the executor run the agent loop. Tools are
// registered WITHOUT `execute`, so the SDK surfaces the tool calls instead of
// running them — keeping the existing executor / WS / PG contract unchanged.

import {
  streamText,
  generateText,
  jsonSchema,
  tool,
  wrapLanguageModel,
  extractReasoningMiddleware,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type LanguageModel,
} from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LlmConfig, LlmDelta, LlmMessage, LlmResult, LlmTool, Provider } from '../types.js';

export type AiSdkFlavor = 'openai-compatible' | 'openai' | 'anthropic';

export interface AiSdkOptions {
  /** Which underlying AI SDK provider to instantiate. */
  flavor: AiSdkFlavor;
  /**
   * If set, wrap the model with `extractReasoningMiddleware` to split
   * `<tag>…</tag>` chain-of-thought out of the content stream (DeepSeek style).
   * Empty string disables it.
   */
  reasoningTag?: string;
}

function buildModel(cfg: LlmConfig, opts: AiSdkOptions): LanguageModel {
  let model: LanguageModel;
  switch (opts.flavor) {
    case 'openai':
      model = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey })(cfg.model);
      break;
    case 'anthropic':
      model = createAnthropic({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey })(cfg.model);
      break;
    case 'openai-compatible':
    default:
      model = createOpenAICompatible({
        name: 'maas',
        baseURL: cfg.baseUrl,
        apiKey: cfg.apiKey,
        includeUsage: true,
      })(cfg.model);
      break;
  }
  if (opts.reasoningTag) {
    model = wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({ tagName: opts.reasoningTag }),
    });
  }
  return model;
}

/** Map neutral `LlmMessage[]` onto AI SDK `ModelMessage[]`. Tool results need a
 *  tool name in v6, so we recover it from the assistant tool-call that owns the
 *  same id. */
export function toModelMessages(msgs: LlmMessage[]): ModelMessage[] {
  const nameById = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) nameById.set(tc.id, tc.name);
    }
  }

  const out: ModelMessage[] = [];
  for (const m of msgs) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: m.content ?? '' });
        break;
      case 'user':
        out.push({ role: 'user', content: m.content ?? '' });
        break;
      case 'assistant': {
        if (m.toolCalls && m.toolCalls.length) {
          const parts: Array<TextPart | ToolCallPart> = [];
          if (m.content) parts.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.arguments || '{}');
            } catch {
              /* malformed args → empty object */
            }
            parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input });
          }
          out.push({ role: 'assistant', content: parts });
        } else {
          out.push({ role: 'assistant', content: m.content ?? '' });
        }
        break;
      }
      case 'tool':
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: m.toolCallId ?? '',
              toolName: nameById.get(m.toolCallId ?? '') ?? 'tool',
              output: { type: 'text', value: m.content ?? '' },
            },
          ],
        });
        break;
    }
  }
  return out;
}

/** Map neutral `LlmTool[]` onto an AI SDK tool set. No `execute`: the SDK
 *  surfaces the tool call and the executor runs it. */
function toToolSet(tools: LlmTool[]) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: jsonSchema(t.parameters as Record<string, unknown>) }),
    ]),
  );
}

export function createAiSdkProvider(cfg: LlmConfig, opts: AiSdkOptions): Provider {
  const model = buildModel(cfg, opts);

  const common = (messages: LlmMessage[], tools: LlmTool[]) => ({
    model,
    messages: toModelMessages(messages),
    tools: toToolSet(tools),
    maxOutputTokens: cfg.maxTokens,
    maxRetries: cfg.retries,
    abortSignal: AbortSignal.timeout(cfg.timeoutMs),
  });

  return {
    name: `aisdk:${opts.flavor}`,

    async complete(messages, tools): Promise<LlmResult> {
      const r = await generateText(common(messages, tools));
      return {
        content: r.text || null,
        reasoning: r.reasoningText ?? null,
        toolCalls: r.toolCalls.map((c) => ({
          id: c.toolCallId,
          name: c.toolName,
          arguments: JSON.stringify(c.input ?? {}),
        })),
        usage: { inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens },
      };
    },

    async completeStream(messages, tools, onDelta: (d: LlmDelta) => void): Promise<LlmResult> {
      const r = streamText(common(messages, tools));
      for await (const part of r.fullStream) {
        if (part.type === 'text-delta') onDelta({ content: part.text });
        else if (part.type === 'reasoning-delta') onDelta({ reasoning: part.text });
        else if (part.type === 'error') throw part.error;
      }
      const [text, reasoningText, toolCalls, usage] = await Promise.all([
        r.text,
        r.reasoningText,
        r.toolCalls,
        r.usage,
      ]);
      return {
        content: text || null,
        reasoning: reasoningText ?? null,
        toolCalls: toolCalls.map((c) => ({
          id: c.toolCallId,
          name: c.toolName,
          arguments: JSON.stringify(c.input ?? {}),
        })),
        usage: { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens },
      };
    },
  };
}
