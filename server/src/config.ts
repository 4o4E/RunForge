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
    // openai-responses | openai-chat | anthropic | mock
    provider: process.env.LLM_PROVIDER ?? 'openai-responses',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 4096),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120000),
    retries: Number(process.env.LLM_MAX_RETRIES ?? 2),
    stream: (process.env.LLM_STREAM ?? 'true') !== 'false',
  },
  agent: {
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 25),
  },
};

export type Config = typeof config;
