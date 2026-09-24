// 三种 LLM 协议共用这个单轮 Provider。AI SDK 负责协议转换、流式解析和工具调用组装；
// RunForge ProviderRunner 负责重试和每次 HTTP attempt 的完整观测。
// 工具不注册 execute，SDK 只返回 tool call，Agent executor 继续执行多轮循环。

import {
  streamText,
  jsonSchema,
  tool,
  type ModelMessage,
  type TextPart,
  type ImagePart,
  type ToolCallPart,
  type LanguageModel,
} from 'ai';
import type { LlmProtocol } from '@runforge/contracts';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LlmConfig, LlmDelta, LlmMessage, LlmProviderState, LlmResult, LlmTool, Provider, ProviderCallOptions } from '../types.js';
import { config } from '../../config.js';
import { toolArgumentsForModel } from '../toolArgs.js';

export interface AiSdkOptions {
  protocol: LlmProtocol;
}

type ReasoningModelPart = {
  type: 'reasoning';
  text: string;
  providerOptions?: TextPart['providerOptions'];
};

function buildModel(cfg: LlmConfig, opts: AiSdkOptions, fetcher?: typeof globalThis.fetch): LanguageModel {
  switch (opts.protocol) {
    case 'openai-responses':
      return createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, fetch: fetcher }).responses(cfg.model);
    case 'anthropic-messages':
      return createAnthropic({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, fetch: fetcher }).messages(cfg.model);
    case 'openai-chat':
      return createOpenAICompatible({
        name: 'maas',
        baseURL: cfg.baseUrl,
        apiKey: cfg.apiKey,
        includeUsage: true,
        fetch: fetcher,
      }).chatModel(cfg.model);
  }
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
  if (opts.protocol === 'anthropic-messages' && cfg.maxOutputTokens === null) {
    throw new Error(`Anthropic 模型 ${cfg.model} 缺少最大输出长度，无法生成协议必填的 max_tokens`);
  }
  const requestProviderOptions = (callOptions?: ProviderCallOptions): Record<string, Record<string, string | boolean>> | undefined => {
    if (opts.protocol === 'openai-responses') return { openai: { store: false } };
    if (opts.protocol === 'openai-chat' && cfg.model === 'glm-5-3-flash-260828' && callOptions?.reasoningEffort) {
      return { maas: { reasoningEffort: callOptions.reasoningEffort } };
    }
    return undefined;
  };
  const common = (messages: LlmMessage[], tools: LlmTool[], functionId: string, callOptions?: ProviderCallOptions) => ({
    model: buildModel(cfg, opts, callOptions?.fetch),
    messages: toModelMessages(messages),
    tools: toToolSet(tools),
    // Anthropic 协议要求 max_tokens；使用已保存的模型最大输出长度，其他协议不发送此参数。
    maxOutputTokens: opts.protocol === 'anthropic-messages' ? cfg.maxOutputTokens! : undefined,
    // 重试由 RunForge ProviderRunner 统一管理，确保每次 HTTP attempt 都可观测。
    maxRetries: 0,
    abortSignal: callOptions?.abortSignal,
    // OpenAI Responses 走无状态模式，确保 reasoning item 返回不可解密的
    // encrypted_content，并由 RunForge 自己持久化；其他协议不发送此选项。
    providerOptions: requestProviderOptions(callOptions),
    // OTEL GenAI spans (chat + tool calls) when telemetry is on. No-op otherwise.
    experimental_telemetry: {
      isEnabled: config.telemetry.enabled,
      functionId,
      metadata: { model: cfg.model, protocol: opts.protocol },
    },
  });

  async function completeByStream(
    messages: LlmMessage[],
    tools: LlmTool[],
    onDelta: (d: LlmDelta) => void,
    callOptions?: ProviderCallOptions,
  ): Promise<LlmResult> {
    // AI SDK 的 chunkMs 从首个 Provider 片段后才开始计时；首个有效输出前仍需独立计时。
    // 推理、正文和工具调用均会发布 onDelta，因此输出期间不受整次请求墙钟时长限制。
    const firstOutputAbort = new AbortController();
    const firstOutputTimer = setTimeout(
      () => firstOutputAbort.abort(new DOMException('等待模型首个输出事件超时', 'TimeoutError')),
      cfg.timeoutMs,
    );
    const abortSignal = callOptions?.abortSignal
      ? AbortSignal.any([callOptions.abortSignal, firstOutputAbort.signal])
      : firstOutputAbort.signal;
    let firstOutputSeen = false;
    const publishDelta = (delta: LlmDelta) => {
      if (!firstOutputSeen) {
        firstOutputSeen = true;
        clearTimeout(firstOutputTimer);
      }
      onDelta(delta);
    };
    try {
      const r = streamText({
        ...common(messages, tools, 'chat', { ...callOptions, abortSignal }),
        timeout: { chunkMs: cfg.timeoutMs },
        // 错误由 fullStream 抛给调用方，统一由 agent 写入带 run/step 的诊断日志。
        onError: () => {},
      });
      for await (const part of r.fullStream) {
        if (part.type === 'text-delta') publishDelta({ content: part.text });
        else if (part.type === 'reasoning-delta') publishDelta({ reasoning: part.text });
        else if (part.type === 'tool-input-start') publishDelta({ toolInputStart: { id: part.id, name: part.toolName } });
        else if (part.type === 'tool-input-delta') publishDelta({ toolInputDelta: { id: part.id, delta: part.delta } });
        else if (part.type === 'tool-call') publishDelta({ toolInputAvailable: { id: part.toolCallId, name: part.toolName, input: part.input } });
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
    } finally {
      clearTimeout(firstOutputTimer);
    }
  }

  return {
    name: `ai-sdk:${opts.protocol}`,
    completeStream: completeByStream,
  };
}
