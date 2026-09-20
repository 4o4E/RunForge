import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { catalogCapability } from './llm/modelCatalog.js';

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

const DEFAULT_LLM_MODEL = 'gpt-4o-mini';
const DEFAULT_LLM_CAPABILITY = catalogCapability(DEFAULT_LLM_MODEL);
const DEFAULT_LLM_CONTEXT_WINDOW = DEFAULT_LLM_CAPABILITY.contextWindow;
const DEFAULT_LLM_COMPACTION_THRESHOLD = DEFAULT_LLM_CAPABILITY.compactionThreshold;
if (DEFAULT_LLM_CONTEXT_WINDOW === null || DEFAULT_LLM_COMPACTION_THRESHOLD === null) {
  throw new Error(`默认模型 ${DEFAULT_LLM_MODEL} 缺少能力目录`);
}

export interface AgentContextSettings {
  modelContextWindow: number;
  contextBudget: number;
  contextBudgetSource: string;
}

/** 每个模型使用目录中的压缩阈值；环境变量只能进一步收紧实例上限。 */
export function agentContextSettings(modelWindow: number, modelCompactionThreshold: number): AgentContextSettings {
  if (!Number.isFinite(modelWindow) || modelWindow <= 0) throw new Error('模型上下文长度无效');
  const safeWindow = Math.floor(modelWindow);
  if (
    !Number.isFinite(modelCompactionThreshold)
    || modelCompactionThreshold <= 0
    || modelCompactionThreshold > safeWindow
  ) {
    throw new Error('模型压缩阈值无效或超过上下文长度');
  }
  const safeThreshold = Math.floor(modelCompactionThreshold);
  const configuredBudget = Number(process.env.LLM_CONTEXT_BUDGET);
  const hasConfiguredBudget = Number.isFinite(configuredBudget) && configuredBudget > 0;
  const budget = hasConfiguredBudget ? Math.min(safeThreshold, Math.floor(configuredBudget)) : safeThreshold;
  return {
    modelContextWindow: safeWindow,
    contextBudget: budget,
    contextBudgetSource: hasConfiguredBudget && budget < safeThreshold ? 'env' : 'model-compaction-threshold',
  };
}

const DEFAULT_AGENT_CONTEXT_SETTINGS = agentContextSettings(
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_LLM_COMPACTION_THRESHOLD,
);
const CONFIGURED_BUSINESS_PLUGIN_ROOTS = patterns(process.env.RUNFORGE_BUSINESS_PLUGIN_ROOTS)
  .map((root) => resolve(root));
const BUSINESS_PLUGIN_ROOTS = CONFIGURED_BUSINESS_PLUGIN_ROOTS.length
  ? CONFIGURED_BUSINESS_PLUGIN_ROOTS
  : [resolve(process.cwd(), '../business-plugins')];

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
    // 兼容路径:老部署的静态共享 token。多租户改造(docs/multi-tenancy-design.md §4)后
    // 只在启动 bootstrap 时使用一次，注册成 bootstrap tenant 下 owner 账号的一条 API token，
    // 不再是唯一的鉴权手段。
    accessToken: process.env.RUNFORGE_ACCESS_TOKEN ?? '',
    shareSecret: process.env.RUNFORGE_SHARE_SECRET ?? process.env.RUNFORGE_ACCESS_TOKEN ?? '',
    // JWT 签名密钥(HS256)。单体部署没有跨服务验签需求,不需要非对称密钥。
    jwtSecret: process.env.RUNFORGE_JWT_SECRET ?? '',
    // access token 短期有效(默认 45 分钟),换取"免查库校验"和"吊销延迟可接受"之间的折中。
    accessTokenTtlSeconds: Number(process.env.RUNFORGE_ACCESS_TOKEN_TTL_SECONDS ?? 45 * 60),
    // refresh token 长期有效(默认 30 天),存 hash,前端用它静默换取新的 access token。
    refreshTokenTtlSeconds: Number(process.env.RUNFORGE_REFRESH_TOKEN_TTL_SECONDS ?? 30 * 24 * 60 * 60),
    // 首次启动引导账号的初始密码；不填则使用固定的自托管默认密码。
    bootstrapAdminPassword: process.env.RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD ?? '',
    bootstrapSysadminPassword: process.env.RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD ?? '',
  },
  llm: {
    // 仅用于首次创建 bootstrap tenant 的可编辑模板；生产运行读取 app_settings。
    protocol: 'openai-responses' as const,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: DEFAULT_LLM_MODEL,
    timeoutMs: 120_000,
    retries: 2,
  },
  agent: {
    // Safety backstop only — NOT the primary control. Long tasks terminate when the
    // model stops calling tools, the user cancels, or the context budget is exhausted.
    // This very-high cap just guards against a runaway loop.
    hardStepCap: Number(process.env.AGENT_HARD_STEP_CAP ?? 1000),
    // Context budget in estimated tokens. Kept conservatively below the model window
    // to avoid context rot. Compaction (mask → window) keeps the working set under it.
    modelContextWindow: DEFAULT_AGENT_CONTEXT_SETTINGS.modelContextWindow,
    contextBudget: DEFAULT_AGENT_CONTEXT_SETTINGS.contextBudget,
    contextBudgetSource: DEFAULT_AGENT_CONTEXT_SETTINGS.contextBudgetSource,
    // Most-recent messages always kept verbatim (never masked or windowed out).
    keepRecentMessages: Number(process.env.AGENT_KEEP_RECENT_MESSAGES ?? 12),
    // 上下文裁剪策略。默认 current 保持现有行为；langchain-trim 只接管普通历史裁剪适配层。
    contextStrategy: contextStrategy(process.env.AGENT_CONTEXT_STRATEGY),
  },
  // Tool sandbox / permission policy (Phase 6). The product is a general-purpose
  // OS agent, so confinement is OPT-IN: TOOL_SANDBOX=enforce turns on path
  // confinement, shell gating and the network switch. 原生工具始终注册，安全边界由
  // 沙箱、网络开关和具体工具约束承担。
  tools: {
    sandbox: ((process.env.TOOL_SANDBOX ?? 'off') === 'enforce' ? 'enforce' : 'off') as 'off' | 'enforce',
    // shell 子进程沙箱后端:auto=Linux+bwrap 时启用,none=直通,bwrap=强制启用。
    sandboxBackend: sandboxBackend(process.env.TOOL_SANDBOX_BACKEND),
    // Filesystem tools are confined under this root in enforce mode. thread 工作目录固定派生为
    // `<root>/<spaceId>/<threadId>`，生产镜像把 /w 链接到持久数据卷。
    workspaceRoot: resolve(process.env.TOOL_WORKSPACE_ROOT ?? '/w'),
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
  providerTrace: {
    // 数据库记录长期保留；本地 JSONL 只作为故障排查缓存，固定保留最近 7 个自然日。
    directory: resolve(process.env.RUNFORGE_PROVIDER_TRACE_DIR ?? resolve(process.cwd(), '../logs/provider-traces')),
    retentionDays: 7,
  },
  businessPlugins: {
    // 第一个根目录同时承载管理页手动导入，其他根目录继续用于部署流水线交付的插件。
    roots: BUSINESS_PLUGIN_ROOTS,
  },
  preview: {
    officeConverterUrl: process.env.OFFICE_PREVIEW_CONVERTER_URL ?? '',
    officeTimeoutMs: Number(process.env.OFFICE_PREVIEW_TIMEOUT_MS ?? 180000),
    officeCacheDir: process.env.OFFICE_PREVIEW_CACHE_DIR ?? '',
    officeCacheVersion: process.env.OFFICE_PREVIEW_CACHE_VERSION ?? '',
  },
  webPush: {
    publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY ?? '',
    subject: process.env.WEB_PUSH_SUBJECT ?? 'mailto:admin@runforge.local',
  },
};

export type Config = typeof config;
