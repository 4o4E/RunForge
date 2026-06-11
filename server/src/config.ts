import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load .env from repo root (one level up from server/)
dotenv.config({ path: resolve(process.cwd(), '../.env') });
dotenv.config(); // also allow server/.env

/** Parse a comma/space separated env list into a trimmed, non-empty array.
 *  For tokens that never contain spaces (tool names, hosts). */
function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Like list() but splits on commas/newlines only, so entries may contain
 *  spaces (e.g. regex patterns like "rm -rf /"). */
function patterns(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    // Safety backstop only — NOT the primary control. Long tasks terminate when the
    // model stops calling tools, the user cancels, or the context budget is exhausted.
    // This very-high cap just guards against a runaway loop.
    hardStepCap: Number(process.env.AGENT_HARD_STEP_CAP ?? 1000),
    // Context budget in estimated tokens. Kept conservatively below the model window
    // to avoid context rot. Compaction (mask → window) keeps the working set under it.
    contextBudget: Number(process.env.LLM_CONTEXT_BUDGET ?? 120000),
    // Fraction of budget that triggers L1 observation masking of old tool results.
    compactWarnRatio: Number(process.env.AGENT_COMPACT_WARN_RATIO ?? 0.75),
    // Fraction of budget that additionally triggers L2 sliding-window truncation.
    compactHardRatio: Number(process.env.AGENT_COMPACT_HARD_RATIO ?? 0.9),
    // Most-recent messages always kept verbatim (never masked or windowed out).
    keepRecentMessages: Number(process.env.AGENT_KEEP_RECENT_MESSAGES ?? 12),
  },
  // Tool sandbox / permission policy (Phase 6). The product is a general-purpose
  // OS agent, so confinement is OPT-IN: TOOL_SANDBOX=enforce turns on path
  // confinement, shell/web gating and host allowlists. `deny`/`allow` lists and
  // the output cap apply in any mode. Default 'off' preserves current behavior.
  tools: {
    sandbox: ((process.env.TOOL_SANDBOX ?? 'off') === 'enforce' ? 'enforce' : 'off') as 'off' | 'enforce',
    // Filesystem tools are confined under this root in enforce mode (default: repo root).
    workspaceRoot: resolve(process.env.TOOL_WORKSPACE_ROOT ?? resolve(process.cwd(), '..')),
    allow: list(process.env.TOOL_ALLOW), // if non-empty, ONLY these tools may run
    deny: list(process.env.TOOL_DENY), // these tools are always blocked
    shellEnabled: (process.env.SHELL_ENABLED ?? 'true') !== 'false',
    // Command patterns blocked in enforce mode (regex, case-insensitive).
    // Override via SHELL_DENY (comma/newline separated, so patterns may contain spaces).
    shellDeny: patterns(process.env.SHELL_DENY).length
      ? patterns(process.env.SHELL_DENY)
      : ['rm\\s+-rf\\s+/', 'mkfs', ':\\(\\)\\s*\\{', 'Format-Volume', 'Remove-Item.*-Recurse.*[CD]:\\\\'],
    webEnabled: (process.env.WEB_ENABLED ?? 'true') !== 'false',
    webAllowHosts: list(process.env.WEB_ALLOW_HOSTS), // if non-empty, ONLY these hosts
    // Hard cap on a single tool result (chars). Always applied. Guards memory/logs.
    maxOutput: Number(process.env.TOOL_MAX_OUTPUT ?? 100000),
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
