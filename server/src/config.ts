import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load .env from repo root (one level up from server/)
dotenv.config({ path: resolve(process.cwd(), '../.env') });
dotenv.config(); // also allow server/.env

const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/my_agent';

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  llm: {
    // aisdk | openai-responses | openai-chat | anthropic | mock
    provider: process.env.LLM_PROVIDER ?? 'aisdk',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 4096),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120000),
    retries: Number(process.env.LLM_MAX_RETRIES ?? 2),
    stream: (process.env.LLM_STREAM ?? 'true') !== 'false',
    // AI SDK provider (used when provider === 'aisdk'):
    //   flavor: openai-compatible (tencentmaas/deepseek/vLLM/…) | openai | anthropic
    //   reasoningTag: split <tag>…</tag> chain-of-thought out of content (DeepSeek);
    //                 empty disables. Default 'think'.
    aisdkFlavor: process.env.LLM_AISDK_FLAVOR ?? 'openai-compatible',
    reasoningTag: process.env.LLM_REASONING_TAG ?? 'think',
  },
  agent: {
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 25),
  },
  // OpenTelemetry GenAI tracing (Phase 4). Disabled by default → zero overhead.
  //   OTEL_ENABLED=true                          turn it on
  //   OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318  send to Langfuse/Laminar/Jaeger
  //   OTEL_CONSOLE=true                          also print spans to stdout (debug)
  telemetry: {
    enabled: (process.env.OTEL_ENABLED ?? 'false') === 'true',
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'my-agent',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
    console: (process.env.OTEL_CONSOLE ?? 'false') === 'true',
  },
};

export type Config = typeof config;
