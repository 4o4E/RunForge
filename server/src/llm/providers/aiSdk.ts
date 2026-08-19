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
  type ImagePart,
  type ToolCallPart,
  type LanguageModel,
} from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LlmConfig, LlmDelta, LlmMessage, LlmProviderState, LlmResult, LlmTool, Provider } from '../types.js';
import { config } from '../../config.js';
import { toolArgumentsForModel } from '../toolArgs.js';

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

type ReasoningModelPart = {
  type: 'reasoning';
  text: string;
  providerOptions?: TextPart['providerOptions'];
};

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
        if (m.contentParts?.length) {
          const parts: Array<TextPart | ImagePart> = m.contentParts.map((part) => (
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image', image: part.data, mediaType: part.mimeType }
          ));
          out.push({ role: 'user', content: parts });
        } else {
          out.push({ role: 'user', content: m.content ?? '' });
        }
        break;
      case 'assistant': {
        if (m.toolCalls?.length || m.providerState?.reasoningParts?.length || m.providerState?.textProviderOptions) {
          const parts: Array<TextPart | ReasoningModelPart | ToolCallPart> = [];
          for (const reasoning of m.providerState?.reasoningParts ?? []) {
            parts.push({
              type: 'reasoning',
              text: reasoning.text,
              providerOptions: reasoning.providerOptions,
            });
          }
          if (m.content) {
            parts.push({
              type: 'text',
              text: m.content,
              providerOptions: m.providerState?.textProviderOptions,
            });
          }
          for (const tc of m.toolCalls ?? []) {
            const input = toolArgumentsForModel(tc.arguments || '{}');
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

/** AI SDK 已把 OpenAI item id / encrypted_content 归一到 providerOptions；
 * 这里只提取 assistant 响应里需要跨轮回放的最小状态。 */
export function providerStateFromResponseMessages(messages: ModelMessage[]): LlmProviderState | undefined {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!assistant || !Array.isArray(assistant.content)) return undefined;
  const reasoningParts = assistant.content.flatMap((part) =>
    part.type === 'reasoning' ? [{ text: part.text, providerOptions: part.providerOptions }] : [],
  );
  const textPart = assistant.content.find((part): part is TextPart => part.type === 'text');
  if (!reasoningParts.length && !textPart?.providerOptions) return undefined;
  return {
    reasoningParts: reasoningParts.length ? reasoningParts : undefined,
    textProviderOptions: textPart?.providerOptions,
  };
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

  const common = (messages: LlmMessage[], tools: LlmTool[], functionId: string) => ({
    model,
    messages: toModelMessages(messages),
    tools: toToolSet(tools),
    maxOutputTokens: cfg.maxTokens ?? undefined,
    maxRetries: cfg.retries,
    abortSignal: AbortSignal.timeout(cfg.timeoutMs),
    // OpenAI Responses 走无状态模式，确保 reasoning item 返回不可解密的
    // encrypted_content，并由 RunForge 自己持久化；其他 flavor 不发送此选项。
    providerOptions: opts.flavor === 'openai' ? { openai: { store: false } } : undefined,
    // OTEL GenAI spans (chat + tool calls) when telemetry is on. No-op otherwise.
    experimental_telemetry: {
      isEnabled: config.telemetry.enabled,
      functionId,
      metadata: { model: cfg.model, flavor: opts.flavor },
    },
  });

  async function completeByStream(messages: LlmMessage[], tools: LlmTool[], onDelta: (d: LlmDelta) => void): Promise<LlmResult> {
    const r = streamText({
      ...common(messages, tools, 'chat'),
      // 错误由 fullStream 抛给调用方，统一由 agent 写入带 run/step 的诊断日志。
      onError: () => {},
    });
    for await (const part of r.fullStream) {
      if (part.type === 'text-delta') onDelta({ content: part.text });
      else if (part.type === 'reasoning-delta') onDelta({ reasoning: part.text });
      else if (part.type === 'tool-input-start') onDelta({ toolInputStart: { id: part.id, name: part.toolName } });
      else if (part.type === 'tool-input-delta') onDelta({ toolInputDelta: { id: part.id, delta: part.delta } });
      else if (part.type === 'tool-call') onDelta({ toolInputAvailable: { id: part.toolCallId, name: part.toolName, input: part.input } });
      else if (part.type === 'error') throw part.error;
    }
    const [text, reasoningText, toolCalls, usage, finishReason, rawFinishReason, response] = await Promise.all([
      r.text,
      r.reasoningText,
      r.toolCalls,
      r.usage,
      r.finishReason,
      r.rawFinishReason,
      r.response,
    ]);
    return {
      content: text || null,
      reasoning: reasoningText ?? null,
      providerState: providerStateFromResponseMessages(response.messages),
      toolCalls: toolCalls.map((c) => ({
        id: c.toolCallId,
        name: c.toolName,
        arguments: JSON.stringify(c.input ?? {}),
      })),
      usage: {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedInputTokens: (usage as { cachedInputTokens?: number } | undefined)?.cachedInputTokens,
      },
      finishReason,
      rawFinishReason,
    };
  }

  return {
    name: `aisdk:${opts.flavor}`,

    async complete(messages, tools): Promise<LlmResult> {
      // 标题和压缩摘要同样必须遵守供应商的流式传输约束。
      if (cfg.stream) return completeByStream(messages, tools, () => {});
      const r = await generateText(common(messages, tools, 'chat'));
      return {
        content: r.text || null,
        reasoning: r.reasoningText ?? null,
        providerState: providerStateFromResponseMessages(r.response.messages),
        toolCalls: r.toolCalls.map((c) => ({
          id: c.toolCallId,
          name: c.toolName,
          arguments: JSON.stringify(c.input ?? {}),
        })),
        usage: {
          inputTokens: r.usage?.inputTokens,
          outputTokens: r.usage?.outputTokens,
          cachedInputTokens: (r.usage as { cachedInputTokens?: number } | undefined)?.cachedInputTokens,
        },
        finishReason: r.finishReason,
        rawFinishReason: r.rawFinishReason,
      };
    },

    async completeStream(messages, tools, onDelta: (d: LlmDelta) => void): Promise<LlmResult> {
      return completeByStream(messages, tools, onDelta);
    },
  };
}
