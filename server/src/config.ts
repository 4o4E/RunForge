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

function sandboxBackend(v: string | undefined): 'auto' | 'none' | 'bwrap' {
  return v === 'none' || v === 'bwrap' ? v : 'auto';
}

function networkMode(v: string | undefined): 'enabled' | 'disabled' {
  if (v === 'enabled' || v === 'on' || v === 'true') return 'enabled';
  if (v === 'disabled' || v === 'off' || v === 'false') return 'disabled';
  return 'disabled';
}

function modelContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('gpt-4.1') || m.includes('gpt-5')) return 1_000_000;
  if (m.includes('claude-3-7') || m.includes('claude-3.7') || m.includes('claude-sonnet-4')) return 200_000;
  if (m.includes('claude') || m.includes('gemini') || m.includes('deepseek')) return 128_000;
  if (m.includes('gpt-4o') || m.includes('o3') || m.includes('o4')) return 128_000;
  if (m.includes('gpt-3.5')) return 16_000;
  return 128_000;
}

function contextBudget(model: string): number {
  if (process.env.LLM_CONTEXT_BUDGET) return Number(process.env.LLM_CONTEXT_BUDGET);
  return Math.floor(modelContextWindow(model) * 0.5);
}

function contextStrategy(v: string | undefined): 'current' | 'langchain-trim' {
  return v === 'langchain-trim' ? 'langchain-trim' : 'current';
}

const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/runforge';
const DEFAULT_SHELL_ALLOW_COMMANDS = [
  'cat',
  'ls',
  'pwd',
  'printf',
  'sed',
  'awk',
  'grep',
  'find',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'xargs',
  'rm',
  'env',
  'git',
  'rg',
  'node',
  'npm',
  'python',
  'python3',
  'uv',
  'curl',
  'psql',
];

export const config = {
  host: process.env.HOST ?? '::',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  auth: {
    accessToken: process.env.RUNFORGE_ACCESS_TOKEN ?? '',
    shareSecret: process.env.RUNFORGE_SHARE_SECRET ?? process.env.RUNFORGE_ACCESS_TOKEN ?? '',
  },
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
    modelContextWindow: modelContextWindow(process.env.LLM_MODEL ?? 'gpt-4o-mini'),
    contextBudget: contextBudget(process.env.LLM_MODEL ?? 'gpt-4o-mini'),
    contextBudgetSource: process.env.LLM_CONTEXT_BUDGET ? 'env' : 'model-default',
    // Fraction of budget that triggers L1 observation masking of old tool results.
    compactWarnRatio: Number(process.env.AGENT_COMPACT_WARN_RATIO ?? 0.75),
    // Fraction of budget that additionally triggers L2 sliding-window truncation.
    compactHardRatio: Number(process.env.AGENT_COMPACT_HARD_RATIO ?? 0.9),
    // Most-recent messages always kept verbatim (never masked or windowed out).
    keepRecentMessages: Number(process.env.AGENT_KEEP_RECENT_MESSAGES ?? 12),
    // 上下文裁剪策略。默认 current 保持现有行为；langchain-trim 只接管普通历史裁剪适配层。
    contextStrategy: contextStrategy(process.env.AGENT_CONTEXT_STRATEGY),
  },
  // Tool sandbox / permission policy (Phase 6). The product is a general-purpose
  // OS agent, so confinement is OPT-IN: TOOL_SANDBOX=enforce turns on path
  // confinement, shell gating and the network switch. `deny`/`allow` lists and
  // the output cap apply in any mode. Default 'off' preserves current behavior.
  tools: {
    sandbox: ((process.env.TOOL_SANDBOX ?? 'off') === 'enforce' ? 'enforce' : 'off') as 'off' | 'enforce',
    // shell 子进程沙箱后端:auto=Linux+bwrap 时启用,none=直通,bwrap=强制启用。
    sandboxBackend: sandboxBackend(process.env.TOOL_SANDBOX_BACKEND),
    // Filesystem tools are confined under this root in enforce mode (default: repo root).
    workspaceRoot: resolve(process.env.TOOL_WORKSPACE_ROOT ?? resolve(process.cwd(), '..')),
    allow: list(process.env.TOOL_ALLOW), // if non-empty, ONLY these tools may run
    deny: list(process.env.TOOL_DENY), // these tools are always blocked
    toolAccessMode: (list(process.env.TOOL_ALLOW).length ? 'allow' : 'deny') as 'allow' | 'deny',
    shellEnabled: (process.env.SHELL_ENABLED ?? 'true') !== 'false',
    // true 时 shell 直接使用宿主机 PATH 和 cwd=workspaceRoot，避免 bwrap 白名单漏投射 CLI。
    shellUseHostPath: (process.env.SHELL_USE_HOST_PATH ?? 'true') !== 'false',
    shellPathMode: (process.env.SHELL_PATH ? 'custom' : 'system') as 'system' | 'custom',
    shellPath: process.env.SHELL_PATH ?? process.env.PATH ?? '',
    // bwrap 模式只投射这些外部命令; shell 内建命令不需要配置。
    shellAllowCommands: list(process.env.SHELL_ALLOW_COMMANDS).length
      ? list(process.env.SHELL_ALLOW_COMMANDS)
      : DEFAULT_SHELL_ALLOW_COMMANDS,
    // 网络总开关:enabled=不限制网络,disabled=阻断网络。
    network: networkMode(process.env.TOOL_NETWORK),
    // Command patterns blocked in enforce mode (regex, case-insensitive).
    // Override via SHELL_DENY (comma/newline separated, so patterns may contain spaces).
    shellDeny: patterns(process.env.SHELL_DENY).length
      ? patterns(process.env.SHELL_DENY)
      : ['rm\\s+-rf\\s+/', 'mkfs', ':\\(\\)\\s*\\{', 'Format-Volume', 'Remove-Item.*-Recurse.*[CD]:\\\\'],
    // Hard cap on a single tool result (chars). Always applied — the L0 first line
    // of context defense, so one huge observation (a recursive dir listing, a big
    // file) can't blow up the window. Kept tight; capOutput keeps head + tail.
    maxOutput: Number(process.env.TOOL_MAX_OUTPUT ?? 40000),
  },
  // OpenTelemetry GenAI tracing (Phase 4). Disabled by default → zero overhead.
  //   OTEL_ENABLED=true                          turn it on
  //   OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318  send to Langfuse/Laminar/Jaeger
  //   OTEL_CONSOLE=true                          also print spans to stdout (debug)
  telemetry: {
    enabled: (process.env.OTEL_ENABLED ?? 'false') === 'true',
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'runforge',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
    console: (process.env.OTEL_CONSOLE ?? 'false') === 'true',
  },
  webPush: {
    publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY ?? '',
    subject: process.env.WEB_PUSH_SUBJECT ?? 'mailto:admin@runforge.local',
  },
};

export type Config = typeof config;
