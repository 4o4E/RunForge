import { agentContextSettings, config, type AgentContextSettings } from '../config.js';
import { getConfiguredProvider, getConfiguredSystemTitleProvider } from '../llm/index.js';
import type { LlmDelta, LlmMessage, LlmUsage, Provider } from '../llm/types.js';
import { parseToolArguments } from '../llm/toolArgs.js';
import { appendImageAttachmentTokens, hydrateImageAttachments } from '../llm/attachments.js';
import { runTool, toolSchemas } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import { createPolicy } from '../tools/policy.js';
import { ContextManager } from './context.js';
import {
  activateSkillItem,
  loadSkillIndex,
  renderSkillCatalog,
  renderSkillSystemRules,
  selectSkill,
} from '../skills/registry.js';
import type { SkillIndexItem, SkillActivation } from '../skills/registry.js';
import {
  DATASOURCE_CREDENTIAL_CAPABILITY,
  createWorkloadToken,
  listAuthorizedDatasources,
  listAuthorizedPermissionProfiles,
  releaseRunLeases,
} from '../datasources/accountPool.js';
import { finishGoal, initGoal, mergeGoal, parseGoalPatch, renderGoal } from './goal.js';
import { runBus } from './bus.js';
import type { AgentEvent, FinishReason } from './types.js';
import { store as defaultStore } from '../store/index.js';
import { scopeForThread, type AppliedRunInput, type Scope, type Store } from '../store/types.js';
import { getSystemMcpSettings, getSystemToolSettings } from '../settings.js';
import type { McpSettings, ToolSettings } from '../settings.js';
import {
  McpClientSession,
  parseMcpToolName,
  renderMcpCatalog,
  renderMcpSystemRules,
  type McpActivation,
} from '../mcp/client.js';
import type { RuntimeCapabilityName } from '@runforge/contracts';
import { withSpan } from '../telemetry.js';
import type { AskUserAnswer, AskUserMode, AskUserOption, AskUserSpec, StreamStage, StreamStats } from './types.js';
import { shellManager } from '../shell/manager.js';
import { requiresDatabaseAccess } from '../tools/databaseAccessGuard.js';
import type { SubagentRunRow } from '../store/types.js';
import { loadWorkflowIndex, renderWorkflowCatalog, renderWorkflowSystemRules } from '../workflows/registry.js';
import { scheduleThreadTitleGeneration } from './threadTitle.js';
import { notifyRunCompleted } from '../notifications/push.js';
import {
  createTenantRuntimeCapabilitiesSnapshot,
  type RunSpaceConfigSnapshot,
  type RuntimeCapabilitiesSnapshot,
} from '../spaces/config.js';
import {
  defaultPromptTemplate,
  renderPromptTemplate,
  runtimeCapabilityPromptValues,
  validatePromptTemplate,
} from '../spaces/prompt.js';
import { ensureThreadWorkspaceRoot, resolveWorkspaceRootForThread } from '../files/workspaceRoot.js';
import { externalArtifactMaterializer } from '../external/artifactMaterializer.js';
import { attachExternalArtifactTokens, type ExternalArtifactTokenSource } from '../external/artifactProtocol.js';
import {
  providerRunner as defaultProviderRunner,
  type ProviderDescriptor,
  type ProviderInvocationContext,
  type ProviderPurpose,
  type ProviderRunner,
} from '../llm/providerRunner.js';
import { businessPluginRegistry, type BusinessPluginRegistry } from '../businessPlugins/registry.js';
import { BusinessPluginError } from '../businessPlugins/errors.js';
import {
  businessPluginRuntime,
  type BusinessPluginRunHandle,
  type BusinessPluginRuntimeService,
  type TenantSecretResolver,
} from '../businessPlugins/runtime.js';
import { readAuditedWorkloadSecrets } from '../businessPlugins/secretService.js';
import { verifySpaceRuntimeLock } from '../plugins/lock.js';
import type { JsonValue, SpaceRuntimeLock } from '../plugins/types.js';
import { materializeWorkloadSdk } from '../workloadSdk/materialize.js';
import { registerRunExecution, retainRunExecution } from './executionControl.js';

const ASK_USER_TOOL_NAME = 'ask_user';
const DATABASE_ACCESS_SKILL_NAME = 'database-access';
const SUBAGENT_RUN_TOOL_NAME = 'subagent_run';
const SUBAGENT_POLL_TOOL_NAME = 'subagent_poll';
const SUBAGENT_LIST_TOOL_NAME = 'subagent_list';
const STREAM_STATS_POINTS = 24;
const STREAM_STATS_MIN_INTERVAL_MS = 250;
const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|key|credential|connectionurl)/i;
const SUBAGENT_MAX_TOOL_TURNS = 12;
const SUBAGENT_POLL_MAX_WAIT_SECONDS = 120;
const SUBAGENT_FORBIDDEN_TOOLS = new Set([
  ASK_USER_TOOL_NAME,
  'update_plan',
  'skill_activate',
  'mcp_activate',
  SUBAGENT_RUN_TOOL_NAME,
  SUBAGENT_POLL_TOOL_NAME,
  SUBAGENT_LIST_TOOL_NAME,
]);
const SUBAGENT_READONLY_TOOLS = [
  'file_read',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'workflow_list',
  'workflow_read',
  'datasource_list',
];
const SUBAGENT_WRITER_TOOLS = [
  ...SUBAGENT_READONLY_TOOLS,
  'file_write',
  'file_edit',
  'shell',
  'shell_session_open',
  'shell_session_reuse',
  'shell_session_list',
  'shell_exec',
  'shell_poll',
  'shell_kill',
  'shell_session_close',
];

export interface ExecutorDeps {
  provider: Provider;
  providerDescriptor: ProviderDescriptor;
  titleProvider: Provider;
  titleProviderDescriptor: ProviderDescriptor;
  providerRunner: ProviderRunner;
  store: Store;
  publish: (runId: string, event: AgentEvent) => void;
  /** 防失控兜底，不是主要流程控制；配置见 config.agent.hardStepCap。 */
  hardStepCap: number;
  resume: boolean;
  toolSettings?: ToolSettings;
  mcpSettings?: McpSettings;
  mcpToolLoader?: (settings: McpSettings, serverId: string) => Promise<McpActivation>;
  workloadRuntimeEnv?: (scope: Scope, runId: string, allowedCapabilities: RuntimeCapabilityName[]) => Promise<WorkloadRuntimeEnv>;
  generateThreadTitle: boolean;
  contextSettings: AgentContextSettings;
  materializeRunArtifacts?: (
    scope: Scope,
    runId: string,
    workspaceRoot: string,
  ) => Promise<ExternalArtifactTokenSource[]>;
  businessPluginRegistry: Pick<BusinessPluginRegistry, 'list' | 'resolveLock'>;
  businessPluginRuntime: Pick<BusinessPluginRuntimeService, 'startRun' | 'syncWorkspace'>;
  businessPluginSecretResolver: TenantSecretResolver;
  releaseRuntimeResources?: (runId: string) => Promise<number>;
}

interface WorkloadRuntimeEnv {
  env: Record<string, string>;
  summary: string;
}

interface ToolTrace {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}

interface LoopGuardHit {
  reason: string;
  question: string;
}

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
}

function charCount(value: unknown): number {
  if (value == null) return 0;
  return Array.from(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 5);
}

class StreamStatsTracker {
  private totals = { outputChars: 0, reasoningChars: 0, toolInputChars: 0, toolOutputChars: 0, totalChars: 0 };
  private bucket = { second: Math.floor(Date.now() / 1000), chars: 0 };
  private history: number[] = [];
  private lastPublishMs = 0;

  constructor(
    private readonly runId: string,
    private readonly publish: (runId: string, event: AgentEvent) => void,
    private readonly persist?: (event: Extract<AgentEvent, { type: 'stream_stats' }>) => void,
  ) {}

  add(step: number, stage: StreamStage, kind: keyof Omit<StreamStats['totals'], 'totalChars'>, chars: number, activeTool?: StreamStats['activeTool']) {
    if (chars <= 0) return;
    this.roll();
    this.totals[kind] += chars;
    this.totals.totalChars += chars;
    this.bucket.chars += chars;
    this.publishStats(step, stage, activeTool);
  }

  mark(step: number, stage: StreamStage, activeTool?: StreamStats['activeTool'], force = false) {
    this.roll();
    this.publishStats(step, stage, activeTool, force);
  }

  startHeartbeat(step: number, stage: () => StreamStage, activeTool?: () => StreamStats['activeTool']): () => void {
    const timer = setInterval(() => this.mark(step, stage(), activeTool?.(), true), 1000);
    return () => clearInterval(timer);
  }

  private roll() {
    const nowSecond = Math.floor(Date.now() / 1000);
    if (nowSecond <= this.bucket.second) return;
    this.history = [...this.history, this.bucket.chars].slice(-STREAM_STATS_POINTS);
    for (let second = this.bucket.second + 1; second < nowSecond; second++) {
      this.history = [...this.history, 0].slice(-STREAM_STATS_POINTS);
    }
    this.bucket = { second: nowSecond, chars: 0 };
  }

  private publishStats(step: number, stage: StreamStage, activeTool?: StreamStats['activeTool'], force = false) {
    const now = Date.now();
    if (!force && now - this.lastPublishMs < STREAM_STATS_MIN_INTERVAL_MS) return;
    this.lastPublishMs = now;
    const event: Extract<AgentEvent, { type: 'stream_stats' }> = {
      type: 'stream_stats',
      step,
      stage,
      updatedAt: new Date(now).toISOString(),
      activeTool,
      totals: { ...this.totals },
      rate: {
        charsPerSecond: this.bucket.chars,
        history: [...this.history, this.bucket.chars].slice(-STREAM_STATS_POINTS),
      },
    };
    this.publish(this.runId, event);
    this.persist?.(event);
  }
}

async function defaultDeps(
  scope: Scope,
  overrides: Partial<ExecutorDeps>,
  modelRef?: string | null,
  spaceConfig?: RunSpaceConfigSnapshot | null,
): Promise<ExecutorDeps> {
  const configured = overrides.provider ? null : await getConfiguredProvider(scope, modelRef ?? undefined);
  const provider = overrides.provider ?? configured!.provider;
  const generateThreadTitle = overrides.generateThreadTitle ?? overrides.store === undefined;
  const configuredTitle = generateThreadTitle && !overrides.titleProvider && !overrides.provider
    ? await getConfiguredSystemTitleProvider()
    : null;
  const titleProvider = overrides.titleProvider ?? configuredTitle?.provider ?? provider;
  return {
    provider,
    providerDescriptor: overrides.providerDescriptor ?? configured?.descriptor ?? {
      provider: provider.name,
      model: modelRef?.trim() || config.llm.model,
      // 注入 Provider 的测试/评估路径在首个可见增量前最多补一次请求。
      retries: 1,
    },
    titleProvider,
    titleProviderDescriptor: overrides.titleProviderDescriptor ?? configuredTitle?.descriptor ?? {
      provider: titleProvider.name,
      model: modelRef?.trim() || config.llm.model,
      retries: 1,
    },
    providerRunner: overrides.providerRunner ?? defaultProviderRunner,
    store: overrides.store ?? defaultStore,
    publish: overrides.publish ?? ((runId, event) => runBus.publish(runId, event)),
    hardStepCap: overrides.hardStepCap ?? config.agent.hardStepCap,
    resume: overrides.resume ?? false,
    toolSettings: overrides.toolSettings,
    mcpSettings: overrides.mcpSettings,
    mcpToolLoader: overrides.mcpToolLoader,
    workloadRuntimeEnv: overrides.workloadRuntimeEnv,
    generateThreadTitle,
    contextSettings: overrides.contextSettings ?? (spaceConfig ? {
      modelContextWindow: spaceConfig.model.contextWindow,
      contextBudget: spaceConfig.model.contextBudget,
      contextBudgetSource: spaceConfig.model.contextBudgetSource,
    } : configured ? agentContextSettings(configured.contextWindow, configured.compactionThreshold) : {
      modelContextWindow: config.agent.modelContextWindow,
      contextBudget: config.agent.contextBudget,
      contextBudgetSource: config.agent.contextBudgetSource,
    }),
    materializeRunArtifacts: overrides.materializeRunArtifacts,
    businessPluginRegistry: overrides.businessPluginRegistry ?? businessPluginRegistry,
    businessPluginRuntime: overrides.businessPluginRuntime ?? businessPluginRuntime,
    businessPluginSecretResolver: overrides.businessPluginSecretResolver ?? (async (request) => {
      if (!request.workloadToken) throw new Error('run 的 WORKLOAD_TOKEN 尚未初始化，不能读取 tenant Secret');
      return readAuditedWorkloadSecrets(request.workloadToken, 'backend', request.stepId, request.keys);
    }),
    releaseRuntimeResources: overrides.releaseRuntimeResources,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function redactShellCommand(command: string): string {
  return command
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY)[A-Z0-9_]*)=('[^']*'|"[^"]*"|[^\s;&|]+)/gi, '$1=[redacted]')
    .replace(/(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, '$1$2:[redacted]@')
    .replace(/(--password(?:=|\s+))('[^']*'|"[^"]*"|[^\s;&|]+)/gi, '$1[redacted]');
}

function redactToolArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactToolArgs);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) out[key] = '[redacted]';
    else if (key === 'command' && typeof item === 'string') out[key] = redactShellCommand(item);
    else out[key] = redactToolArgs(item);
  }
  return out;
}

function toolSignature(name: string, args: unknown): string {
  return `${name}:${stableJson(args)}`;
}

function blockedQuestion(reason: string): string {
  return `我检测到任务可能没有继续取得进展：${reason}\n请补充约束、确认下一步，或回复“按默认假设继续”。`;
}

function detectLoopGuard(signatures: string[], failures: string[]): LoopGuardHit | null {
  const last3 = signatures.slice(-3);
  if (last3.length === 3 && last3.every((s) => s === last3[0])) {
    const reason = `连续 3 次重复调用同一个工具和参数：${last3[0]}`;
    return { reason, question: blockedQuestion(reason) };
  }
  const fail3 = failures.slice(-3);
  if (fail3.length === 3 && fail3.every((s) => s === fail3[0])) {
    const reason = `连续 3 次遇到相同工具失败：${fail3[0]}`;
    return { reason, question: blockedQuestion(reason) };
  }
  return null;
}

function isPendingSubagentWait(name: string, result: string): boolean {
  return (name === SUBAGENT_POLL_TOOL_NAME || name === SUBAGENT_LIST_TOOL_NAME) && /\bstatus: running\b/.test(result);
}

function renderAbnormalFinishMessage(finishReason: FinishReason, rawFinishReason: string | undefined, hasText: boolean): string {
  const raw = rawFinishReason && rawFinishReason !== finishReason ? `，上游原始原因：${rawFinishReason}` : '';
  if (finishReason === 'length') {
    return `模型输出达到上限，被截断后停止${raw}。已保留当前已生成内容，可以点击“继续生成”从最后一个完整 step 继续。`;
  }
  if (finishReason === 'content-filter') {
    return `模型输出被内容安全策略拦截${raw}。已保留当前已生成内容，请调整请求或换模型后重试。`;
  }
  if (finishReason === 'tool-calls') {
    return `模型结束原因为 tool-calls，但本轮没有返回可执行工具调用${raw}。这通常是供应商兼容层异常，请重试或切换模型。`;
  }
  if (finishReason === 'error') {
    return `模型侧报告生成错误${raw}。${hasText ? '已保留当前已生成内容，' : ''}可以重试继续生成。`;
  }
  return `模型未以正常 stop 结束：finishReason=${finishReason}${raw}。${hasText ? '已保留当前已生成内容，' : ''}可以重试继续生成。`;
}

function errorStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function commandFromToolCall(name: string, args: unknown): string | null {
  if (name !== 'shell' && name !== 'shell_exec') return null;
  const command = args && typeof args === 'object' ? (args as Record<string, unknown>).command : null;
  return typeof command === 'string' ? command : null;
}

function subagentProfile(runtimeProfileId: string | null): { label: string; tools: string[] } {
  if (runtimeProfileId === 'writer') return { label: 'writer', tools: SUBAGENT_WRITER_TOOLS };
  return { label: runtimeProfileId ?? 'default-readonly', tools: SUBAGENT_READONLY_TOOLS };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numericArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function addUsage(total: LlmUsage | undefined, next: LlmUsage | undefined): LlmUsage | undefined {
  if (!next) return total;
  return {
    inputTokens: (total?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cachedInputTokens: (total?.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
  };
}

async function loadRuntimeCapabilitiesSnapshot(store: Store, scope: Scope, runId: string): Promise<RuntimeCapabilitiesSnapshot> {
  const run = await store.getRunUnscoped(runId);
  const raw = run?.runtime_capabilities_snapshot;
  if (raw && typeof raw === 'object') return raw as unknown as RuntimeCapabilitiesSnapshot;
  const settings = store === defaultStore
    ? await createTenantRuntimeCapabilitiesSnapshot(scope.tenantId)
    : {
        llm: { enabled: false, defaultModelId: '', models: [] },
        image: { enabled: false, defaultModelId: '', models: [] },
        allowedCapabilities: [],
        video: { enabled: false, defaultModelId: '', models: [] },
      };
  const snapshot: RuntimeCapabilitiesSnapshot = settings;
  if (store === defaultStore) {
    await store.setRuntimeCapabilitiesSnapshot(scope, runId, snapshot);
  }
  return snapshot;
}

function runSpaceConfigSnapshot(value: unknown): RunSpaceConfigSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Omit<Partial<RunSpaceConfigSnapshot>, 'schemaVersion'> & {
    schemaVersion?: number;
    systemPrompt?: unknown;
  };
  if (typeof raw.spaceId !== 'string') return null;
  if (
    (raw.schemaVersion !== 1 && raw.schemaVersion !== 3)
    || (raw.mode !== 'web' && raw.mode !== 'external')
    || (raw.schemaVersion === 3 && typeof raw.promptTemplate !== 'string')
    || (raw.schemaVersion === 1 && typeof raw.systemPrompt !== 'string')
    || !raw.model
    || typeof raw.model.modelRef !== 'string'
    || !Array.isArray(raw.model.allowedModelRefs)
    || typeof raw.model.contextWindow !== 'number'
    || typeof raw.model.contextBudget !== 'number'
    || typeof raw.model.contextBudgetSource !== 'string'
    || !raw.capabilities
    || !Array.isArray(raw.capabilities.tools)
    || !Array.isArray(raw.capabilities.mcpServers)
    || (raw.capabilities.businessPlugins !== undefined && !Array.isArray(raw.capabilities.businessPlugins))
    || !Array.isArray(raw.capabilities.runtime)
    || !raw.external
    || typeof raw.external.allowTrustedPrompt !== 'boolean'
    || typeof raw.external.allowNextStep !== 'boolean'
  ) {
    throw new Error('run 的空间配置副本无效，拒绝回退到当前空间配置');
  }
  return {
    ...raw,
    schemaVersion: 3,
    promptTemplate: raw.schemaVersion === 3
      ? validatePromptTemplate(raw.promptTemplate ?? '')
      : defaultPromptTemplate(raw.mode, typeof raw.systemPrompt === 'string' ? raw.systemPrompt : ''),
    capabilities: {
      ...raw.capabilities,
      // 兼容业务插件协议接入前已经接纳、但尚未执行完的 run。
      businessPlugins: raw.capabilities.businessPlugins ?? [],
    },
  } as RunSpaceConfigSnapshot;
}

function runPluginLock(value: unknown): SpaceRuntimeLock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return verifySpaceRuntimeLock(value as SpaceRuntimeLock);
}

function businessPluginIdFromRuntimeId(id: string): string {
  if (!id.startsWith('business.')) throw new Error(`run plugin_lock 包含非业务插件：${id}`);
  return id.slice('business.'.length);
}

function businessPluginConfigFromLock(lock: SpaceRuntimeLock): Record<string, Readonly<Record<string, unknown>>> {
  return Object.fromEntries(lock.plugins.map((plugin) => {
    const config = plugin.config && typeof plugin.config === 'object' && !Array.isArray(plugin.config)
      ? plugin.config as Record<string, JsonValue>
      : {};
    return [businessPluginIdFromRuntimeId(plugin.id), config];
  }));
}

async function createDefaultWorkloadRuntimeEnv(scope: Scope, runId: string, allowedCapabilities: RuntimeCapabilityName[]): Promise<WorkloadRuntimeEnv> {
  const datasourceAllowed = allowedCapabilities.includes(DATASOURCE_CREDENTIAL_CAPABILITY);
  const activeDatasources = datasourceAllowed
    ? (await listAuthorizedDatasources(scope)).filter((datasource) => datasource.enabled && datasource.status === 'active')
    : [];
  const allowedDatasourceIds = activeDatasources.map((datasource) => datasource.id);
  const created = await createWorkloadToken(scope, {
    runId,
    allowedDatasourceIds,
    allowedCapabilities,
  });

  const env: Record<string, string> = {
    WORKLOAD_TOKEN: created.token,
    RUNFORGE_RUNTIME_API_BASE: runtimeApiBase(),
    DATASOURCE_PROFILE: 'readonly',
  };
  env.MY_AGENT_RUNTIME_API_BASE = env.RUNFORGE_RUNTIME_API_BASE;

  if (activeDatasources.length === 1) {
    const datasource = activeDatasources[0];
    env.DATASOURCE_ID = datasource.id;
    const profiles = await listAuthorizedPermissionProfiles(scope, datasource.id);
    const readonly = profiles.find((profile) => profile.mode === 'readonly');
    env.DATASOURCE_PROFILE = readonly?.name ?? 'readonly';
  }

  const visible = [
    'WORKLOAD_TOKEN=已注入',
    `RUNFORGE_RUNTIME_API_BASE=${env.RUNFORGE_RUNTIME_API_BASE}`,
    env.DATASOURCE_ID ? `DATASOURCE_ID=${env.DATASOURCE_ID}` : 'DATASOURCE_ID=未自动选择',
    `DATASOURCE_PROFILE=${env.DATASOURCE_PROFILE}`,
    `allowedDatasourceIds=${allowedDatasourceIds.length ? allowedDatasourceIds.join(',') : '无'}`,
    `allowedCapabilities=${allowedCapabilities.length ? allowedCapabilities.join(',') : '无'}`,
  ];

  return {
    env,
    summary: [
      '统一运行资源环境（run 级）:',
      ...visible.map((item) => `- ${item}`),
      '- WORKLOAD_TOKEN 只是换取本次 run 短期凭证和内部能力代理配置的令牌，不是数据库密码或上游 API key。',
      '- 涉及数据库 CLI 时必须使用 database-access helper 换取本 run 的短期凭证；不要复用旧 run 的数据库用户名、密码、DATABASE_URL 或宿主默认账号。',
    ].join('\n'),
  };
}

function findMissingToolResults(messages: LlmMessage[]): { id: string; name: string }[] {
  const answered = new Set(messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string));
  const missing: { id: string; name: string }[] = [];
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      if (!answered.has(call.id)) missing.push({ id: call.id, name: call.name });
    }
  }
  return missing;
}

function askUserMode(value: unknown): AskUserMode {
  return value === 'single' || value === 'multiple' || value === 'text' ? value : 'text';
}

function askUserOptions(value: unknown): AskUserOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: AskUserOption[] = [];
  value.forEach((item, index) => {
    const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const label = String(raw.label ?? raw.value ?? '').trim();
    if (!label) return;
    const idBase = String(raw.id ?? label).trim() || `option-${index + 1}`;
    let id = idBase;
    let suffix = 2;
    while (seen.has(id)) id = `${idBase}-${suffix++}`;
    seen.add(id);
    options.push({
      id,
      label,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      recommended: raw.recommended === true,
      required: raw.required === true,
    });
  });
  return options;
}

function normalizeAskUserSpec(args: Record<string, unknown>): AskUserSpec {
  const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : '请补充必要信息。';
  const mode = askUserMode(args.mode);
  const options = mode === 'text' ? [] : askUserOptions(args.options);
  return {
    question,
    mode,
    options,
    allowCustom: mode !== 'text' && args.allowCustom !== false,
    required: args.required === true,
  };
}

function defaultAskUserAnswer(): AskUserAnswer {
  return {
    mode: 'text',
    selected: [],
    customOptions: [],
    text: '',
    note: '按默认假设继续。',
    usedRecommended: true,
  };
}

function runtimeApiBase(): string {
  return (process.env.RUNFORGE_RUNTIME_API_BASE ?? process.env.MY_AGENT_RUNTIME_API_BASE ?? `http://127.0.0.1:${config.port}/api/runtime`).replace(/\/+$/, '');
}

/**
 * 核心 agent 循环，按 thread → run → step 组织。
 *
 * 一个 run 对应一次用户输入；每次循环是一轮 LLM 调用及其工具调用。
 * 运行前会加载同一 thread 的历史消息，让 agent 具备多轮记忆。
 * 所有依赖都可注入，便于在没有 PG/网络的情况下做单元测试。
 */
export async function executeRun(runId: string, overrides: Partial<ExecutorDeps> & { scope?: Scope } = {}): Promise<void> {
  const registration = registerRunExecution(runId);
  try {
    await executeRunControlled(runId, overrides, registration.signal, registration.bindThread);
  } finally {
    registration.finish();
  }
}

async function executeRunControlled(
  runId: string,
  overrides: Partial<ExecutorDeps> & { scope?: Scope },
  cancellationSignal: AbortSignal,
  bindExecutionThread: (threadId: string) => void,
): Promise<void> {
  const { scope: scopeOverride, ...depOverrides } = overrides;
  const usesDefaultStore = depOverrides.store === undefined;
  const store = depOverrides.store ?? defaultStore;
  // executeRun 自己从 runId 反推 scope，不依赖 AsyncLocalStorage——recovery.ts 等后台任务
  // 调用它时完全没有请求身份，ALS 也不保证穿透 EventEmitter 回调
  // (docs/multi-tenancy-design.md §7、auth/context.ts 的注释)。这个 id 在 HTTP 路由里已经
  // 被身份校验过，这里只是重新推导同一个已证明过的归属，不是信任一个未经验证的外部 id。
  const run = await store.getRunUnscoped(runId);
  if (!run) throw new Error(`run 不存在：${runId}`);
  const owningThread = await store.getThreadUnscoped(run.thread_id);
  if (!owningThread) throw new Error(`thread 不存在：${run.thread_id}`);
  bindExecutionThread(owningThread.id);
  const initialThread = owningThread;
  const scope: Scope = scopeOverride ?? scopeForThread(owningThread);
  let spaceConfig: RunSpaceConfigSnapshot | null = null;
  let pluginLock: SpaceRuntimeLock | null = null;
  let deps: ExecutorDeps;
  try {
    spaceConfig = runSpaceConfigSnapshot(run.space_config_snapshot);
    pluginLock = runPluginLock(run.plugin_lock);
    if (spaceConfig && run.model_ref && run.model_ref !== spaceConfig.model.modelRef) {
      throw new Error('run 的模型与空间配置副本不一致');
    }
    if (pluginLock) {
      if (
        pluginLock.tenantId !== scope.tenantId
        || pluginLock.spaceId !== initialThread.space_id
        || pluginLock.configVersion !== run.space_config_version
      ) {
        throw new Error('run 的 plugin_lock 与 tenant/space/config version 不一致');
      }
      const lockedIds = pluginLock.plugins.map((plugin) => businessPluginIdFromRuntimeId(plugin.id)).sort();
      const configuredIds = [...(spaceConfig?.capabilities.businessPlugins ?? [])].sort();
      if (JSON.stringify(lockedIds) !== JSON.stringify(configuredIds)) {
        throw new Error('run 的 plugin_lock 与空间配置副本中的业务插件不一致');
      }
    } else if (spaceConfig?.capabilities.businessPlugins.length) {
      throw new Error('run 已选择业务插件但缺少 plugin_lock');
    }
    const generateThreadTitle = (depOverrides.generateThreadTitle ?? usesDefaultStore)
      && initialThread.source_type === 'web';
    deps = await defaultDeps(scope, {
      ...depOverrides,
      store,
      generateThreadTitle,
      releaseRuntimeResources: depOverrides.releaseRuntimeResources ?? (usesDefaultStore ? releaseRunLeases : undefined),
    }, run.model_ref ?? spaceConfig?.model.modelRef, spaceConfig);
  } catch (err) {
    const current = await store.getRun(scope, runId);
    if (cancellationSignal.aborted || current?.status === 'canceling' || current?.status === 'canceled') {
      if (current && current.status !== 'canceled') {
        const message = cancellationSignal.reason instanceof Error
          ? cancellationSignal.reason.message
          : '用户已取消 run。';
        await store.setRunStatus(scope, runId, 'canceled', { error: message });
      }
      if (usesDefaultStore) await releaseRunLeases(runId).catch(() => {});
      return;
    }
    const message = (err as Error).message;
    console.warn(`[agent] run ${runId} failed before start: ${errorStack(err)}`);
    const publish = depOverrides.publish ?? ((targetRunId, event) => runBus.publish(targetRunId, event));
    const event: AgentEvent = { type: 'error', step: 0, message };
    publish(runId, event);
    await store.addEvent(scope, runId, null, event);
    await store.setRunStatus(scope, runId, 'error', { error: message });
    if (usesDefaultStore) await releaseRunLeases(runId).catch(() => {});
    return;
  }
  const { provider, publish, hardStepCap, resume } = deps;
  const initialRun = run;
  const threadId = initialRun.thread_id;
  const userInput = initialRun.input;

  const observedProvider = (
    purpose: ProviderPurpose,
    stepId: string | null,
    targetProvider = provider,
    descriptor = deps.providerDescriptor,
    onRetry?: (input: { attempt: number; message: string }) => void | Promise<void>,
  ): Provider => {
    const context: ProviderInvocationContext = {
      tenantId: scope.tenantId,
      spaceId: initialThread.space_id,
      threadId,
      runId,
      stepId,
      purpose,
      ...descriptor,
    };
    return {
      name: targetProvider.name,
      completeStream: (messages, tools, onDelta) => deps.providerRunner.run({
        provider: targetProvider,
        context,
        messages,
        tools,
        onDelta,
        onRetry,
        abortSignal: cancellationSignal,
      }),
    };
  };

  const emit = async (stepId: string | null, event: AgentEvent) => {
    publish(runId, event);
    await store.addEvent(scope, runId, stepId, event);
  };
  const emitUsageUpdate = async (stepId: string, step: number, usage?: LlmUsage) => {
    await emit(stepId, {
      type: 'usage_update',
      step,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      estContextTokens: currentCtx?.estTokens(),
      contextBudget: deps.contextSettings.contextBudget,
    });
  };

  const persistCompaction = async (stepId: string | null, compaction: Awaited<ReturnType<ContextManager['maybeCompact']>>) => {
    if (!compaction) return;
    if (compaction.summaryMessage && compaction.summarizedIds.length) {
      const summaryId = await store.addSummaryMessage(
        scope,
        threadId,
        runId,
        stepId,
        compaction.summaryMessage,
        compaction.summarizedIds,
      );
      // L3 摘要在工作上下文中不是最后一条，需要按对象引用回填 DB id。
      currentCtx?.setSummaryDbId(compaction.summaryMessage, summaryId);
      await store.markMessagesCollapsed(scope, compaction.summarizedIds, 'summarized');
    }
    const summarized = new Set(compaction.summarizedIds);
    const maskedIds = compaction.collapsedIds.filter((id) => !summarized.has(id));
    if (maskedIds.length) {
      await store.markMessagesCollapsed(scope, maskedIds, 'masked');
    }
    await emit(stepId, {
      type: 'compaction',
      step: currentStepIdx,
      occurredAt: new Date().toISOString(),
      ...compaction.info,
      affected: compaction.affected,
      summary: compaction.summaryMessage?.content ?? undefined,
    });
  };

  let currentCtx: ContextManager | null = null;
  let currentStepIdx = 0;
  const mcpSession = new McpClientSession();
  const runtimeResources: { businessPluginHandle?: BusinessPluginRunHandle } = {};

  if (!await store.beginRunExecution(scope, runId)) {
    const current = await store.getRun(scope, runId);
    if (current?.status === 'canceling') {
      await emit(null, { type: 'error', step: 0, message: '用户已取消 run。' });
      await store.setRunStatus(scope, runId, 'canceled');
      await deps.releaseRuntimeResources?.(runId).catch((error) => {
        console.warn(`run ${runId} 取消后的运行资源释放失败：${(error as Error).message}`);
      });
    }
    await mcpSession.dispose();
    return;
  }

  try {
    await withSpan(
      'invoke_agent',
      { 'run.id': runId, 'thread.id': threadId, 'agent.hard_step_cap': hardStepCap },
      () => runLoop(),
    );
  } catch (err) {
    if (cancellationSignal.aborted) {
      const current = await store.getRun(scope, runId);
      if (current && current.status !== 'canceled') {
        const message = cancellationSignal.reason instanceof Error
          ? cancellationSignal.reason.message
          : '用户已取消 run。';
        await emit(null, { type: 'error', step: currentStepIdx || 0, message });
        await store.setRunStatus(scope, runId, 'canceled', { error: message });
      }
    } else {
      const message = (err as Error).message;
      console.warn(`[agent] run ${runId} step ${currentStepIdx || 0} provider ${provider.name} failed: ${errorStack(err)}`);
      await emit(null, { type: 'error', step: 0, message });
      await store.setRunStatus(scope, runId, 'error', { error: message });
    }
  } finally {
    const cleanup = await Promise.allSettled([
      mcpSession.dispose(),
      runtimeResources.businessPluginHandle?.dispose() ?? Promise.resolve(),
      deps.releaseRuntimeResources?.(runId) ?? Promise.resolve(0),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        console.warn(`run ${runId} 运行资源释放失败：${(result.reason as Error).message}`);
      }
    }
  }

  // agent 主循环保持为闭包，让 invoke_agent span 包住内部的模型调用和工具执行 span。
  async function runLoop(): Promise<void> {
    const existingMessageCount = await store.countRunMessages(scope, runId);
    const hasPersistedMessages = existingMessageCount > 0;
    const shouldRecover = resume || hasPersistedMessages;
    let prior = await store.loadThreadMessages(scope, threadId, { runId });
    let nextStepIdx = (await store.getLastStepIndex(scope, runId)) + 1;

    // 恢复时如果进程死在工具执行中间，库里可能只有 assistant tool_call，
    // 没有对应 tool_result。这里补一条中断结果，保证 provider 消息配对完整。
    if (shouldRecover) {
      const missing = findMissingToolResults(prior);
      for (const call of missing) {
        const content =
          `Tool call "${call.name}" was interrupted before producing a result; continue from the latest durable state or rerun it if still needed.\n` +
          `工具调用 "${call.name}" 在返回结果前被中断；请基于已持久化状态继续，必要时重新执行。`;
        await store.addMessage(scope, threadId, runId, null, { role: 'tool', content, toolCallId: call.id });
        await emit(null, { type: 'recovery', step: Math.max(1, nextStepIdx), message: content });
      }
      if (missing.length) prior = await store.loadThreadMessages(scope, threadId, { runId });
    }

    // Goal 恢复时优先使用已保存状态；普通模型请求通过 update_plan 工具结果读取完整状态。
    let goal = initialRun.goal_state ?? initGoal(userInput);
    if (!initialRun.goal_state) await store.setGoalState(scope, runId, goal);
    let toolSettings = deps.toolSettings ?? (await getSystemToolSettings());
    if (!deps.toolSettings) {
      const workspaceBase = toolSettings.workspaceRoot;
      const workspace = resolveWorkspaceRootForThread(initialThread, workspaceBase);
      await ensureThreadWorkspaceRoot(initialThread.space_id, initialThread.id, workspaceBase);
      toolSettings = { ...toolSettings, workspaceRoot: workspace.root };
    }
    const materializeRunArtifacts = deps.materializeRunArtifacts
      ?? (store === defaultStore
        ? (targetScope: Scope, targetRunId: string, workspaceRoot: string) => (
            externalArtifactMaterializer.materializeRun(targetScope, targetRunId, workspaceRoot)
          )
        : null);
    const materializeExternalArtifacts = async (): Promise<ExternalArtifactTokenSource[]> => {
      if (spaceConfig?.mode !== 'external' || !materializeRunArtifacts) return [];
      return materializeRunArtifacts(scope, runId, toolSettings.workspaceRoot);
    };
    const initialArtifacts = await materializeExternalArtifacts();
    const runtimeUserInput = attachExternalArtifactTokens(userInput, initialArtifacts);
    const toolPolicy = createPolicy(toolSettings);
    let runWorkloadToken: string | null = null;
    if (pluginLock?.plugins.length) {
      let definitions;
      try {
        definitions = await deps.businessPluginRegistry.resolveLock(scope.tenantId, pluginLock);
      } catch (error) {
        if (!(error instanceof BusinessPluginError) || error.code !== 'BUSINESS_PLUGIN_NOT_READY') throw error;
        // 服务重启后内存索引可能只保留新部署；runtime 会优先读取当前 workspace 中按 hash
        // 保存的 run 副本，并且仅在副本不存在时尝试当前 tenant 部署。
        definitions = await deps.businessPluginRegistry.list(scope.tenantId);
      }
      runtimeResources.businessPluginHandle = await deps.businessPluginRuntime.startRun({
        runId,
        workspaceRoot: toolSettings.workspaceRoot,
        definitions,
        lock: pluginLock,
        tenantConfig: businessPluginConfigFromLock(pluginLock),
        resolveSecrets: (request) => deps.businessPluginSecretResolver({
          ...request,
          workloadToken: runWorkloadToken,
        }),
      });
    } else if (pluginLock) {
      await deps.businessPluginRuntime.syncWorkspace(toolSettings.workspaceRoot, new Set());
    }
    const tenantMcpSettings = deps.mcpSettings ?? (deps.store === defaultStore ? await getSystemMcpSettings() : { servers: [] });
    const allowedMcpServerIds = spaceConfig ? new Set(spaceConfig.capabilities.mcpServers) : null;
    const selectedTenantMcpSettings = allowedMcpServerIds
      ? { servers: tenantMcpSettings.servers.filter((server) => allowedMcpServerIds.has(server.id)) }
      : tenantMcpSettings;
    const mcpSettings: McpSettings = {
      servers: [...selectedTenantMcpSettings.servers, ...(runtimeResources.businessPluginHandle?.mcpServers ?? [])],
    };
    const refreshBusinessMcpServers = async (stepId?: string | null): Promise<void> => {
      const handle = runtimeResources.businessPluginHandle;
      if (!handle) return;
      const businessIds = new Set(handle.mcpServers.map((server) => server.id));
      const refreshed = await handle.refreshMcpServers(stepId);
      handle.mcpServers.splice(0, handle.mcpServers.length, ...refreshed);
      mcpSettings.servers = [
        ...mcpSettings.servers.filter((server) => !businessIds.has(server.id)),
        ...refreshed,
      ];
    };
    const duplicateMcpId = mcpSettings.servers.find((server, index) => (
      mcpSettings.servers.findIndex((candidate) => candidate.id === server.id) !== index
    ))?.id;
    if (duplicateMcpId) throw new Error(`空间运行时存在重复 MCP Server ID：${duplicateMcpId}`);
    const allowedBuiltinToolNames = spaceConfig
      ? new Set(spaceConfig.capabilities.tools.filter((tool) => spaceConfig!.mode !== 'external' || tool !== ASK_USER_TOOL_NAME))
      : null;
    const capabilitySnapshot = await loadRuntimeCapabilitiesSnapshot(store, scope, runId);
    const toolEnv: Record<string, string> = {};
    toolEnv.RUNFORGE_WORKLOAD_SDK = await materializeWorkloadSdk(toolSettings.workspaceRoot);
    const workloadRuntimeEnvProvider = deps.workloadRuntimeEnv ?? (deps.store === defaultStore ? createDefaultWorkloadRuntimeEnv : null);
    let workloadRuntimeSummary = '';
    if (workloadRuntimeEnvProvider) {
      const runtime = await workloadRuntimeEnvProvider(scope, runId, capabilitySnapshot.allowedCapabilities);
      Object.assign(toolEnv, runtime.env);
      runWorkloadToken = runtime.env.WORKLOAD_TOKEN ?? null;
      if (!runWorkloadToken) throw new Error('统一运行资源环境没有返回 WORKLOAD_TOKEN');
      workloadRuntimeSummary = runtime.summary;
    }
    const skillIndex = [
      ...await loadSkillIndex(toolSettings.workspaceRoot),
      ...(runtimeResources.businessPluginHandle?.skills ?? []),
    ].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
    const activateIndexedSkill = async (nameOrId: string): Promise<SkillActivation> => {
      const skill = selectSkill(skillIndex, nameOrId);
      if (!skill) throw new Error(`未找到 skill: ${nameOrId}`);
      return activateSkillItem(skill, toolSettings.workspaceRoot);
    };
    const workflowIndex = await loadWorkflowIndex(toolSettings.workspaceRoot);
    const mcpToolLoader = async (settings: McpSettings, serverId: string, stepId?: string | null): Promise<McpActivation> => {
      if (runtimeResources.businessPluginHandle?.mcpServers.some((server) => server.id === serverId)) {
        await refreshBusinessMcpServers(stepId);
      }
      return deps.mcpToolLoader
        ? deps.mcpToolLoader(settings, serverId)
        : mcpSession.activate(settings, serverId, cancellationSignal);
    };
    const runEvents = await store.getEvents(scope, runId);
    const activeSkills: SkillIndexItem[] = [];
    const activeMcp = new Map<string, McpActivation>();

    // 激活状态以 run 事件恢复：同一 run 重启后继续生效，新 run 没有这些事件，天然清空。
    for (const event of runEvents) {
      if (event.type === 'skill_activated' && !activeSkills.some((skill) => skill.id === event.skillId)) {
        const skill = skillIndex.find((item) => item.id === event.skillId);
        if (skill) activeSkills.push(skill);
      }
      if (event.type === 'mcp_activated' && !activeMcp.has(event.serverId)) {
        try {
          activeMcp.set(event.serverId, await mcpToolLoader(mcpSettings, event.serverId, null));
        } catch (err) {
          console.warn(`恢复 run ${runId} 的 MCP ${event.serverId} 激活状态失败：${(err as Error).message}`);
        }
      }
    }

    const runtimeCapabilityValues = runtimeCapabilityPromptValues(capabilitySnapshot);
    const prompt = renderPromptTemplate(spaceConfig?.promptTemplate ?? defaultPromptTemplate(spaceConfig?.mode ?? 'web'), {
      'workspace.root': toolSettings.workspaceRoot,
      'sandbox.mode': toolSettings.sandbox,
      'sandbox.backend': toolSettings.sandboxBackend,
      'shell.hostPath': toolSettings.shellUseHostPath ? '是' : '否',
      'network.mode': toolSettings.network,
      'workflow.catalog': [renderWorkflowSystemRules(), renderWorkflowCatalog(workflowIndex)].join('\n\n'),
      'skills.catalog': [renderSkillSystemRules(), renderSkillCatalog(skillIndex)].join('\n\n'),
      'mcp.catalog': [renderMcpSystemRules(), renderMcpCatalog(mcpSettings)].join('\n\n'),
      'runtime.environment': workloadRuntimeSummary,
      'runtime.enabledCapabilities': runtimeCapabilityValues.enabledCapabilities,
      'runtime.capabilityDetails': runtimeCapabilityValues.capabilityDetails,
      'external.trustedPrompt': spaceConfig?.external.trustedPrompt ?? '',
    });
    const ctx = new ContextManager(prior, runtimeUserInput, renderGoal(goal), {
      appendUserInput: !hasPersistedMessages,
      systemPrompt: prompt,
      contextSettings: deps.contextSettings,
    });
    currentCtx = ctx;
    if (!hasPersistedMessages) {
      // 新 run 或尚未写入任何消息的 pending run，必须先落用户输入。
      await store.addMessage(scope, threadId, runId, null, { role: 'user', content: runtimeUserInput });
    }

    const stepIds = new Map<number, string>();
    let livePersistQueue = Promise.resolve();
    const persistLiveEvent = (event: AgentEvent) => {
      const stepId = 'step' in event ? stepIds.get(event.step) ?? null : null;
      // 流式事件需要实时落库，刷新/切换会话时才能从 DB 恢复当前状态。
      livePersistQueue = livePersistQueue.then(() => store.addEvent(scope, runId, stepId, event)).catch((err) => {
        console.warn(`persist live event failed for ${runId}: ${(err as Error).message}`);
      });
    };
    const publishLiveEvent = (event: AgentEvent) => {
      publish(runId, event);
      persistLiveEvent(event);
    };
    const streamStats = new StreamStatsTracker(runId, publish, persistLiveEvent);
    const recentToolSignatures: string[] = [];
    const recentFailures: string[] = [];
    let noActionTurns = 0;
    const acceptsNextStep = spaceConfig?.mode === 'external' && spaceConfig.external.allowNextStep;

    const addAppliedExternalInputs = async (
      inputs: AppliedRunInput[],
      stepId: string,
      stepIdx: number,
    ): Promise<void> => {
      if (inputs.length) await materializeExternalArtifacts();
      for (const input of inputs) {
        const message = { role: 'user' as const, content: input.content };
        ctx.add(message);
        ctx.setLastDbId(input.messageId);
        await emit(stepId, {
          type: 'external_input_applied',
          step: stepIdx,
          inputId: input.inputId,
          version: input.version,
        });
      }
      if (inputs.length) {
        // 新输入代表调用方提供了新的推进信息，旧的空转/重复检测不能跨边界误判。
        noActionTurns = 0;
        recentToolSignatures.length = 0;
        recentFailures.length = 0;
      }
    };

    const applyPendingExternalInputs = async (stepId: string, stepIdx: number): Promise<void> => {
      if (!acceptsNextStep) return;
      await addAppliedExternalInputs(await store.applyPendingRunInputs(scope, runId), stepId, stepIdx);
    };

    const prepareExternalStop = async (
      stepId: string,
      stepIdx: number,
    ): Promise<'finish' | 'continue'> => {
      if (!acceptsNextStep) return 'finish';
      const result = await store.closeExternalInputAndApplyPending(scope, runId);
      if (!result.closed) {
        // canceling 等状态变化赢得了同一行上的竞争；回到循环顶部按最新状态收口。
        return 'continue';
      }
      await addAppliedExternalInputs(result.inputs, stepId, stepIdx);
      return result.inputs.length ? 'continue' : 'finish';
    };

    const envForStep = (stepId: string): Record<string, string> => ({
      ...toolEnv,
      RUNFORGE_STEP_ID: stepId,
    });

    const databaseToolEnvMessage = (): string => {
      if (!capabilitySnapshot.allowedCapabilities.includes(DATASOURCE_CREDENTIAL_CAPABILITY)) {
        return '当前空间没有授权 datasource.credentials，不能注入数据库短期凭证。';
      }
      if (toolEnv.WORKLOAD_TOKEN) return '数据库访问运行环境已在 run 初始化时注入；database-access skill 只提供脚本和操作规范。';
      return 'run 的统一 WORKLOAD_TOKEN 初始化失败，不能通过激活 Skill 补签 token。';
    };

    const renderSubagentRow = (row: SubagentRunRow, includeTask: boolean): string => {
      const task = optionalString(row.task_assignment?.task) ?? '未记录';
      const modelRef = optionalString(row.task_assignment?.modelRef);
      const lines = [
        `subagentRunId: ${row.id}`,
        `status: ${row.status}`,
        `stageId: ${row.stage_id ?? '未指定'}`,
        `runtimeProfileId: ${row.runtime_profile_id ?? 'default'}`,
        `modelRef: ${modelRef ?? '主 agent 默认模型'}`,
        `createdAt: ${row.created_at}`,
      ];
      if (row.finished_at) lines.push(`finishedAt: ${row.finished_at}`);
      if (includeTask) lines.push(`task: ${task}`);
      if (row.status === 'done') lines.push('', row.output ?? 'subagent 已完成，但没有返回文本结果。');
      if (row.status === 'error') lines.push('', `subagent 执行失败：${row.error ?? '未知错误'}`);
      if (row.status === 'running') {
        lines.push('', 'subagent 仍在后台执行。可以稍后继续调用 subagent_poll，或用 subagent_list 查看当前 thread 的所有 subagent。');
      }
      return lines.join('\n');
    };

    const completeSubagent = async (
      row: SubagentRunRow,
      args: Record<string, unknown>,
      stepId: string,
      stepIdx: number,
      startedAt: string,
      abortSignal: AbortSignal,
    ): Promise<void> => {
      const task = optionalString(args.task) ?? '未记录';
      const workflowId = optionalString(args.workflowId);
      const stageId = optionalString(args.stageId);
      const stageGoal = optionalString(args.stageGoal);
      const runtimeProfileId = optionalString(args.runtimeProfileId);
      const modelRef = optionalString(args.modelRef);
      const skillNames = stringList(args.skillNames);
      const taskAssignment = row.task_assignment;
      const profile = subagentProfile(runtimeProfileId);

      try {
        abortSignal.throwIfAborted();
        if (modelRef && spaceConfig && !spaceConfig.model.allowedModelRefs.includes(modelRef)) {
          throw new Error(`subagent 模型未被当前空间允许：${modelRef}`);
        }
        const skillMessages: string[] = [];
        for (const name of skillNames) {
          try {
            const activation = await activateIndexedSkill(name);
            skillMessages.push(activation.systemMessage);
          } catch (err) {
            skillMessages.push(`Skill "${name}" 加载失败：${(err as Error).message}`);
          }
        }
        const profileTools = allowedBuiltinToolNames
          ? profile.tools.filter((tool) => allowedBuiltinToolNames.has(tool))
          : profile.tools;
        const toolSchemasForProfile = await toolSchemas(profileTools, [], !spaceConfig);
        const tools = toolSchemasForProfile.filter((tool) => !SUBAGENT_FORBIDDEN_TOOLS.has(tool.name));
        const allowedToolNames = new Set(tools.map((tool) => tool.name));

        const messages: LlmMessage[] = [
          {
            role: 'system',
            content: [
              profile.label === 'writer'
                ? `你是当前 thread 内部的异步 writer subagent，runtimeProfileId=${profile.label}。`
                : `你是当前 thread 内部的异步只读推理型 subagent，runtimeProfileId=${profile.label}。`,
              profile.label === 'writer'
                ? `You are an asynchronous writer subagent inside the current thread, runtimeProfileId=${profile.label}.`
                : `You are an asynchronous read-only reasoning subagent inside the current thread, runtimeProfileId=${profile.label}.`,
              profile.label === 'writer'
                ? '你可以调用本轮提供的工具读写 workspace 文件、执行 shell，并必须只声称自己真实执行过的动作。'
                : '你只能调用本轮提供的只读工具收集证据；不要修改文件、执行写操作或声称自己创建了文件。',
              profile.label === 'writer'
                ? 'You may use the provided tools to read/write workspace files and run shell commands; only claim actions actually performed.'
                : 'Use only the provided read-only tools for evidence; do not modify files or claim that you created files.',
              '不要调用 subagent_*、ask_user、update_plan 或 skill_activate；需要额外 skill 时由主 agent 调度。',
              'Do not call subagent_*, ask_user, update_plan, or skill_activate; the main agent schedules extra skills.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `workflowId: ${workflowId ?? '未指定'}`,
              `stageId: ${stageId ?? '未指定'}`,
              `stageGoal: ${stageGoal ?? '未指定'}`,
              `runtimeProfileId: ${runtimeProfileId ?? 'default'}`,
              `modelRef: ${modelRef ?? '主 agent 默认模型'}`,
              '',
              'Task assignment:',
              JSON.stringify(taskAssignment, null, 2),
              '',
              skillMessages.length ? `Loaded skills:\n${skillMessages.join('\n\n---\n\n')}` : 'Loaded skills: none',
              '',
              profile.label === 'writer'
                ? '请完成任务；如果需要创建文件或运行命令，直接调用工具执行。最后输出：完成情况、真实产物路径、关键证据、风险/不确定性。'
                : '请输出：结论、关键证据、风险/不确定性、建议下一步。',
            ].join('\n'),
          },
        ];

        const selectedProvider = modelRef
          ? await getConfiguredProvider(scope, modelRef)
          : { provider, descriptor: deps.providerDescriptor };
        const subagentProvider = observedProvider(
          'subagent',
          stepId,
          selectedProvider.provider,
          selectedProvider.descriptor,
        );
        const toolTrace: string[] = [];
        let output = '';
        let usage: LlmUsage | undefined;
        for (let turn = 0; turn < SUBAGENT_MAX_TOOL_TURNS; turn += 1) {
          const result = await subagentProvider.completeStream(messages, tools, () => {}, { abortSignal });
          abortSignal.throwIfAborted();
          usage = addUsage(usage, result.usage);
          output = result.content?.trim() || output;
          const assistantMsg = {
            role: 'assistant' as const,
            content: result.content,
            toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
            providerState: result.providerState,
          };
          messages.push(assistantMsg);
          if (!result.toolCalls.length) break;

          for (const call of result.toolCalls) {
            abortSignal.throwIfAborted();
            let text: string;
            const parsedArgs = parseToolArguments(call.arguments || '{}');
            if (!allowedToolNames.has(call.name)) {
              text = `subagent 当前 profile 不允许调用工具：${call.name}`;
            } else if (!parsedArgs.ok) {
              text = `工具参数无效，未执行 ${call.name}：${parsedArgs.error}`;
            } else {
              const command = commandFromToolCall(call.name, parsedArgs.args);
              if (
                command
                && requiresDatabaseAccess(command)
                && !activeSkills.some((skill) => skill.name === DATABASE_ACCESS_SKILL_NAME)
              ) {
                text = 'subagent 需要数据库访问时必须先由主 agent 激活 database-access skill；本次未执行数据库命令。';
              } else {
                const resultText = await runTool(call.name, parsedArgs.args, {
                  scope,
                  settings: toolSettings,
                  env: envForStep(stepId),
                  threadId,
                  runId,
                  stepId,
                  step: stepIdx,
                  mcpSettings,
                  abortSignal,
                });
                text = resultText.text;
              }
            }
            abortSignal.throwIfAborted();
            toolTrace.push(`- ${call.name}: ${text.split('\n')[0]?.slice(0, 200) ?? ''}`);
            messages.push({ role: 'tool', content: text, toolCallId: call.id });
          }
        }
        if (!output) output = 'subagent 未返回文本结果。';
        if (toolTrace.length) {
          output = `${output}\n\n工具执行摘要 / Tool execution summary:\n${toolTrace.join('\n')}`;
        }
        const endedAt = new Date().toISOString();
        await store.finishSubagentRun(scope, row.id, {
          status: 'done',
          output,
          usage: usage ? { ...usage } : null,
        });
        await emit(stepId, {
          type: 'subagent_finished',
          step: stepIdx,
          subagentRunId: row.id,
          output,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          startedAt,
          endedAt,
          durationMs: durationMs(startedAt, endedAt),
        });
      } catch (err) {
        const error = (err as Error).message;
        const endedAt = new Date().toISOString();
        await store.finishSubagentRun(scope, row.id, { status: 'error', error });
        await emit(stepId, {
          type: 'subagent_failed',
          step: stepIdx,
          subagentRunId: row.id,
          error,
          startedAt,
          endedAt,
          durationMs: durationMs(startedAt, endedAt),
        });
        console.warn(`subagent ${row.id} failed for task "${task}": ${error}`);
      }
    };

    const startSubagent = async (
      args: Record<string, unknown>,
      stepId: string,
      stepIdx: number,
      toolStartedAt: string,
    ): Promise<{ text: string }> => {
      const task = optionalString(args.task);
      if (!task) return { text: 'subagent_run 缺少必填 task。' };

      const workflowId = optionalString(args.workflowId);
      const stageId = optionalString(args.stageId);
      const stageGoal = optionalString(args.stageGoal);
      const runtimeProfileId = optionalString(args.runtimeProfileId);
      const modelRef = optionalString(args.modelRef);
      const skillNames = stringList(args.skillNames);
      const taskAssignment = {
        task,
        context: optionalString(args.context),
        expectedOutput: optionalString(args.expectedOutput),
        constraints: optionalString(args.constraints),
        stageGoal,
        modelRef,
      };

      const row = await store.createSubagentRun(scope, {
        parentRunId: runId,
        parentStepId: stepId,
        workflowId,
        stageId,
        runtimeProfileId,
        taskAssignment,
        skillNames,
      });
      await emit(stepId, {
        type: 'subagent_started',
        step: stepIdx,
        subagentRunId: row.id,
        workflowId,
        stageId,
        runtimeProfileId,
        modelRef,
        skillNames,
        task,
        startedAt: toolStartedAt,
      });

      const subagentExecution = retainRunExecution(runId);
      void completeSubagent(row, args, stepId, stepIdx, toolStartedAt, subagentExecution.signal)
        .finally(() => subagentExecution.finish());
      return {
        text: [
          `subagentRunId: ${row.id}`,
          'status: running',
          `stageId: ${stageId ?? '未指定'}`,
          `runtimeProfileId: ${runtimeProfileId ?? 'default'}`,
          `modelRef: ${modelRef ?? '主 agent 默认模型'}`,
          '',
          'subagent 已在后台启动，本次工具调用不会等待它完成。',
          '后续可以调用 subagent_poll 查询该子任务，或调用 subagent_list 查看当前 thread 的所有 subagent；这些查询可以跨 run 使用。',
        ].join('\n'),
      };
    };

    const pollSubagent = async (args: Record<string, unknown>): Promise<{ text: string }> => {
      const subagentRunId = optionalString(args.subagentRunId);
      if (!subagentRunId) return { text: 'subagent_poll 缺少必填 subagentRunId。' };
      const waitSeconds = Math.min(Math.max(numericArg(args.waitSeconds ?? args.timeoutSeconds, 0), 0), SUBAGENT_POLL_MAX_WAIT_SECONDS);
      const deadline = Date.now() + waitSeconds * 1000;
      let row = await store.getSubagentRun(scope, subagentRunId);
      if (!row) return { text: `没有找到 subagentRunId: ${subagentRunId}` };
      const rowId = row.id;
      const visibleRows = await store.listSubagentRunsByThread(scope, threadId);
      if (!visibleRows.some((item) => item.id === rowId)) {
        return { text: `当前 thread 无权读取 subagentRunId: ${subagentRunId}` };
      }
      while (row.status === 'running' && Date.now() < deadline) {
        await waitMs(Math.min(1000, Math.max(100, deadline - Date.now())));
        row = (await store.getSubagentRun(scope, subagentRunId)) ?? row;
      }
      if (row.status === 'running' && waitSeconds > 0) {
        return { text: `${renderSubagentRow(row, false)}\n\n等待 ${waitSeconds} 秒后仍未完成，返回当前状态。` };
      }
      return { text: renderSubagentRow(row, true) };
    };

    const listSubagents = async (args: Record<string, unknown>): Promise<{ text: string }> => {
      const rawStatus = optionalString(args.status);
      const status = rawStatus === 'running' || rawStatus === 'done' || rawStatus === 'error' ? rawStatus : null;
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 20;
      const limit = Math.min(Math.max(rawLimit, 1), 50);
      let rows = await store.listSubagentRunsByThread(scope, threadId);
      if (status) rows = rows.filter((row) => row.status === status);
      rows = rows.slice(-limit);
      if (!rows.length) return { text: status ? `当前 thread 没有 ${status} 状态的 subagent。` : '当前 thread 还没有 subagent。' };
      return {
        text: rows
          .map((row) => renderSubagentRow(row, true))
          .join('\n\n---\n\n'),
      };
    };

    // 长任务由完成、取消、上下文预算决定结束；hardStepCap 只是防死循环兜底。
    for (let stepIdx = nextStepIdx; stepIdx < nextStepIdx + hardStepCap; stepIdx++) {
      currentStepIdx = stepIdx;
      // 取消接口会把状态改成 canceling；每步开头检查后干净退出。
      const current = await store.getRun(scope, runId);
      if (cancellationSignal.aborted || current?.status === 'canceling' || current?.status === 'canceled') {
        try {
          await shellManager.killRunCommands(scope, runId, 'run_cancel');
        } catch (err) {
          const message = (err as Error).message;
          if (!message.includes('relation "shell_commands" does not exist')) {
            console.warn(`shell command cleanup during cancel failed: ${message}`);
          }
        }
        await emit(null, { type: 'error', step: stepIdx, message: '用户已取消 run。' });
        await store.setRunStatus(scope, runId, 'canceled');
        return;
      }

      const step = await store.createStep(scope, runId, stepIdx);
      stepIds.set(stepIdx, step.id);
      await emit(step.id, { type: 'step_start', step: stepIdx });
      // next_step 只能出现在完整 step 之间；落库事务已经先创建 user message，
      // 这里再把同一内容加入内存上下文，重启时仍可从 messages 恢复。
      await applyPendingExternalInputs(step.id, stepIdx);
      streamStats.mark(stepIdx, 'llm_waiting', undefined, true);

      // 模型调用前先控制工作上下文大小；mask 决策会落库，窗口丢弃只留在内存。
      const compaction = await ctx.maybeCompact(observedProvider('compaction', step.id));
      await persistCompaction(step.id, compaction);
      // 每个 step 调模型前先推估算上下文，避免等待模型返回期间占用为空。
      await emitUsageUpdate(step.id, stepIdx);
      // 一次模型请求内的能力集合必须保持不变；本轮激活的 Skill/MCP 从下一次请求才生效。
      const requestMcpServerIds = new Set(activeMcp.keys());
      const requestActiveSkillNames = new Set(activeSkills.map((skill) => skill.name));
      let requestAllowedToolNames = new Set<string>();

      // 实时发布流式增量；完整文本只在末尾落库，历史回放更紧凑。
      let result;
      let persistedLiveContent = false;
      let persistedLiveReasoning = false;
      const llmStartedAt = new Date().toISOString();
      let reasoningStartedAt: string | null = null;
      let llmStage: StreamStage = 'llm_waiting';
      let llmActiveTool: StreamStats['activeTool'];
      const streamedToolInputChars = new Map<string, number>();
      const streamedToolNames = new Map<string, string>();
      const stopLlmHeartbeat = streamStats.startHeartbeat(stepIdx, () => llmStage, () => llmActiveTool);
      try {
        const activeMcpTools = [...activeMcp.values()].flatMap((activation) => activation.tools);
        const selectedToolNames = allowedBuiltinToolNames
          ? [...allowedBuiltinToolNames, ...activeMcpTools.map((tool) => tool.mappedName)]
          : undefined;
        const tools = await toolSchemas(selectedToolNames, activeMcpTools, !spaceConfig);
        requestAllowedToolNames = new Set(tools.map((tool) => tool.name));
        const modelMessages = await hydrateImageAttachments(ctx.all(), toolSettings.workspaceRoot);
        await store.saveStepContext(scope, step.id, {
          messages: modelMessages,
          tools,
          stream: true,
          capturedAt: new Date().toISOString(),
        });
        const onStreamDelta = (d: LlmDelta) => {
          if (d.toolInputStart) {
            llmStage = 'tool_call';
            llmActiveTool = d.toolInputStart;
            streamedToolNames.set(d.toolInputStart.id, d.toolInputStart.name);
            streamStats.mark(stepIdx, 'tool_call', d.toolInputStart, true);
          }
          if (d.toolInputDelta) {
            llmStage = 'tool_call';
            if (d.toolInputDelta.name) streamedToolNames.set(d.toolInputDelta.id, d.toolInputDelta.name);
            const name = streamedToolNames.get(d.toolInputDelta.id) ?? d.toolInputDelta.name ?? 'tool';
            llmActiveTool = { id: d.toolInputDelta.id, name };
            const chars = charCount(d.toolInputDelta.delta);
            streamedToolInputChars.set(d.toolInputDelta.id, (streamedToolInputChars.get(d.toolInputDelta.id) ?? 0) + chars);
            streamStats.add(stepIdx, 'tool_call', 'toolInputChars', chars, llmActiveTool);
          }
          if (d.toolInputAvailable) {
            llmStage = 'tool_call';
            llmActiveTool = { id: d.toolInputAvailable.id, name: d.toolInputAvailable.name };
            streamedToolNames.set(d.toolInputAvailable.id, d.toolInputAvailable.name);
            const chars = charCount(d.toolInputAvailable.input);
            const counted = streamedToolInputChars.get(d.toolInputAvailable.id) ?? 0;
            const remaining = Math.max(0, chars - counted);
            if (remaining) {
              streamedToolInputChars.set(d.toolInputAvailable.id, counted + remaining);
              streamStats.add(stepIdx, 'tool_call', 'toolInputChars', remaining, llmActiveTool);
            } else {
              streamStats.mark(stepIdx, 'tool_call', llmActiveTool, true);
            }
          }
          if (d.reasoning) {
            llmStage = 'reasoning';
            llmActiveTool = undefined;
            reasoningStartedAt ??= new Date().toISOString();
            streamStats.add(stepIdx, 'reasoning', 'reasoningChars', charCount(d.reasoning));
            persistedLiveReasoning = true;
            publishLiveEvent({ type: 'reasoning', step: stepIdx, text: d.reasoning, startedAt: reasoningStartedAt });
          }
          if (d.content) {
            llmStage = 'output';
            llmActiveTool = undefined;
            streamStats.add(stepIdx, 'output', 'outputChars', charCount(d.content));
            persistedLiveContent = true;
            publishLiveEvent({ type: 'llm_delta', step: stepIdx, text: d.content });
          }
        };
        const stepProvider = observedProvider('agent', step.id, provider, deps.providerDescriptor, async ({ message }) => {
          console.warn(
            `[agent] run ${runId} step ${stepIdx} provider ${provider.name} 流式请求在首个增量前失败，将保持流式协议重试：${message}`,
          );
          // 诊断事件只落库，不推给前端，避免一次可恢复重试被显示成失败。
          await store.addEvent(scope, runId, step.id, {
            type: 'stream_retry',
            step: stepIdx,
            provider: provider.name,
            message,
          });
        });
        result = await stepProvider.completeStream(modelMessages, tools, onStreamDelta);
      } finally {
        stopLlmHeartbeat();
      }
      await livePersistQueue;
      const llmEndedAt = new Date().toISOString();

      // 用真实 token 用量校准估算器，供下一次压缩判断使用。
      ctx.recordUsage(result.usage);
      if (result.usage) await emitUsageUpdate(step.id, stepIdx, result.usage);

      const { content, reasoning, toolCalls } = result;
      if (reasoning && !persistedLiveReasoning) {
        streamStats.add(stepIdx, 'reasoning', 'reasoningChars', charCount(reasoning), undefined);
      }
      if (content && !persistedLiveContent) {
        streamStats.add(stepIdx, 'output', 'outputChars', charCount(content), undefined);
      }

      // reasoning 只给前端展示，不回填到模型上下文。
      if (reasoning) {
        const startedAt = reasoningStartedAt ?? llmStartedAt;
        const timing = { startedAt, endedAt: llmEndedAt, durationMs: durationMs(startedAt, llmEndedAt) };
        const ev = { type: 'reasoning' as const, step: stepIdx, text: reasoning, ...timing };
        if (persistedLiveReasoning) {
          await emit(step.id, { type: 'reasoning_timing', step: stepIdx, ...timing });
        } else {
          await store.addEvent(scope, runId, step.id, ev);
          await emit(step.id, { type: 'reasoning_timing', step: stepIdx, ...timing });
        }
      }

      // messages 是 Debug 与恢复的原始日志；普通事件仍走 redactToolArgs，避免默认 UI
      // 暴露密钥。OpenAI 的加密推理状态只做不透明回放，应用不会尝试解密。
      const assistantMsg = {
        role: 'assistant' as const,
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        providerState: result.providerState,
      };
      ctx.add(assistantMsg);
      ctx.setLastDbId(await store.addMessage(scope, threadId, runId, step.id, assistantMsg));
      // Skill 入口已经被本次 LLM 请求完整消费；立即折叠其工具结果，保留原始落库内容与配对。
      await persistCompaction(step.id, ctx.collapseConsumedToolResults(['skill_activate'], 'skill-activation-consumed'));

      if (toolCalls.length && result.finishReason && result.finishReason !== 'tool-calls') {
        const message = renderAbnormalFinishMessage(result.finishReason, result.rawFinishReason, Boolean(content?.trim()));
        console.warn(
          `[agent] run ${runId} step ${stepIdx} provider ${provider.name} returned abnormal finishReason=${result.finishReason}` +
            `${result.rawFinishReason ? ` rawFinishReason=${result.rawFinishReason}` : ''} with ${toolCalls.length} tool calls; marking run error.`,
        );
        streamStats.mark(stepIdx, 'error', undefined, true);
        await livePersistQueue;
        await emit(step.id, {
          type: 'error',
          step: stepIdx,
          message,
          finishReason: result.finishReason,
          rawFinishReason: result.rawFinishReason,
        });
        await store.setRunStatus(scope, runId, 'error', { error: message });
        return;
      }

      if (content && !persistedLiveContent) {
        const ev = { type: 'llm_delta' as const, step: stepIdx, text: content };
        await store.addEvent(scope, runId, step.id, ev);
      }

      if (!toolCalls.length) {
        const finalText = content?.trim() ?? '';
        const finishReason = result.finishReason ?? 'stop';
        const rawFinishReason = result.rawFinishReason;
        if (finishReason !== 'stop') {
          const message = renderAbnormalFinishMessage(finishReason, rawFinishReason, Boolean(finalText));
          console.warn(
            `[agent] run ${runId} step ${stepIdx} provider ${provider.name} returned abnormal finishReason=${finishReason}` +
              `${rawFinishReason ? ` rawFinishReason=${rawFinishReason}` : ''}; marking run error.`,
          );
          streamStats.mark(stepIdx, 'error', undefined, true);
          await livePersistQueue;
          await emit(step.id, { type: 'error', step: stepIdx, message, finishReason, rawFinishReason });
          await store.setRunStatus(scope, runId, 'error', { error: message });
          return;
        }
        if (finalText) {
          if (await prepareExternalStop(step.id, stepIdx) === 'continue') continue;
          // 无工具的可见正文就是本轮对话的终点。计划状态只做收敛记录，
          // 不能再反向驱动模型补跑一轮，否则会用后续短摘要覆盖真实最终输出。
          goal = finishGoal(goal);
          await store.setGoalState(scope, runId, goal);
          ctx.setGoal(renderGoal(goal));
          if (goal.plan.length) await emit(step.id, { type: 'plan_update', step: stepIdx, goal });
          await persistCompaction(step.id, ctx.compactForHistory());
          streamStats.mark(stepIdx, 'done', undefined, true);
          await livePersistQueue;
          await emit(step.id, { type: 'final', step: stepIdx, output: finalText, finishReason, rawFinishReason });
          await store.setRunStatus(scope, runId, 'done', { output: finalText });
          if (usesDefaultStore) {
            void notifyRunCompleted(scope, runId, { store, output: finalText })
              .catch((err) => console.warn(`对话完成通知推送失败：${(err as Error).message}`));
          }
          if (deps.generateThreadTitle) {
            const titleExecution = retainRunExecution(runId);
            void scheduleThreadTitleGeneration(scope, runId, {
              store,
              provider: observedProvider(
                'title',
                null,
                deps.titleProvider,
                deps.titleProviderDescriptor,
              ),
            }).finally(() => titleExecution.finish());
          }
          return;
        }

        noActionTurns += 1;
        if (noActionTurns >= 3) {
          const reason = `连续 ${noActionTurns} 个 step 没有工具调用，也没有有效最终汇报。`;
          if (spaceConfig?.mode === 'external') {
            if (await prepareExternalStop(step.id, stepIdx) === 'continue') continue;
            await emit(step.id, { type: 'error', step: stepIdx, message: reason });
            await store.setRunStatus(scope, runId, 'error', { error: reason });
            return;
          }
          const question = blockedQuestion(reason);
          await emit(step.id, { type: 'progress_stalled', step: stepIdx, reason, question });
          await emit(step.id, { type: 'user_question', step: stepIdx, question });
          await store.setRunStatus(scope, runId, 'waiting_for_user');
          return;
        }
        ctx.add({
          role: 'system',
          content: '上一轮没有工具调用，也没有输出可见正文。请继续执行需要的工具，或直接输出完整最终回答。不要只为了关闭计划而空转。',
        });
        continue;
      }
      noActionTurns = 0;

      const toolTraces: ToolTrace[] = [];
      const applySkillActivation = async (activation: SkillActivation): Promise<string> => {
        if (
          activation.skill.name === DATABASE_ACCESS_SKILL_NAME
          && !capabilitySnapshot.allowedCapabilities.includes(DATASOURCE_CREDENTIAL_CAPABILITY)
        ) {
          return '当前空间没有授权 datasource.credentials，拒绝激活 database-access skill。';
        }
        const alreadyActive = activeSkills.some((skill) => skill.id === activation.skill.id);
        if (!alreadyActive) {
          activeSkills.push(activation.skill);
          await emit(step.id, {
            type: 'skill_activated',
            step: stepIdx,
            skillId: activation.skill.id,
            name: activation.skill.name,
            source: activation.skill.source,
            root: activation.skill.root,
            readonly: activation.skill.readonly,
            hash: activation.skill.hash,
          });
        }
        let runtimeEnvMessage = '';
        if (activation.skill.name === DATABASE_ACCESS_SKILL_NAME) {
          runtimeEnvMessage = `\n\n${databaseToolEnvMessage()}`;
        }
        if (activation.skill.source === 'business' && toolEnv.WORKLOAD_TOKEN) {
          runtimeEnvMessage += '\n\n业务 Skill 可动态 import 环境变量 RUNFORGE_WORKLOAD_SDK 指向的统一 SDK，并使用本 run 的 WORKLOAD_TOKEN 获取 tenant Secret 和空间已授权的运行资源；插件声明用于管理员配置提示，不是 key 级权限边界。不要输出 token、Secret 或短期凭证。';
        }
        // Skill 入口通过工具结果进入上下文，也必须遵守统一单条输出上限。
        return toolPolicy.capOutput(`${activation.systemMessage}${runtimeEnvMessage}`);
      };

      const applyMcpActivation = async (serverId: string): Promise<string> => {
        const id = serverId.trim();
        const existing = activeMcp.get(id);
        if (existing) return `MCP ${id} 已在当前 run 激活，共 ${existing.tools.length} 个工具。`;
        const activation = await mcpToolLoader(mcpSettings, id, step.id);
        activeMcp.set(id, activation);
        await emit(step.id, {
          type: 'mcp_activated',
          step: stepIdx,
          serverId: activation.server.id,
          label: activation.server.label,
          description: activation.server.description,
          toolNames: activation.tools.map((tool) => tool.mappedName),
        });
        const names = activation.tools.map((tool) => tool.mappedName).join(', ') || '无';
        // MCP 可能返回大量工具名；激活回执也必须遵守统一的单条工具输出上限。
        return toolPolicy.capOutput(`已激活 MCP ${activation.server.id}。从当前 run 的下一次模型请求开始加载 ${activation.tools.length} 个工具：${names}`);
      };

      // 执行模型请求的每个工具，并把结果回填给模型。
      for (const call of toolCalls) {
        cancellationSignal.throwIfAborted();
        const parsedArgs = parseToolArguments(call.arguments || '{}');
        const args = parsedArgs.args;
        const startedAt = new Date().toISOString();
        const trace: ToolTrace = { id: call.id, name: call.name, args, startedAt };
        toolTraces.push(trace);
        const activeTool = { id: call.id, name: call.name };
        const toolInputChars = charCount(call.arguments);
        const streamedInputChars = streamedToolInputChars.get(call.id) ?? 0;
        streamStats.add(stepIdx, 'tool_call', 'toolInputChars', Math.max(0, toolInputChars - streamedInputChars), activeTool);
        await emit(step.id, { type: 'tool_call', step: stepIdx, id: call.id, name: call.name, args: redactToolArgs(args), startedAt });

        const blockedBySpace = !requestAllowedToolNames.has(call.name);
        if (!parsedArgs.ok || blockedBySpace) {
          const endedAt = new Date().toISOString();
          const text = !parsedArgs.ok
            ? `工具参数无效，未执行 ${call.name}：${parsedArgs.error}`
            : `工具 ${call.name} 未被当前 run 的空间配置授权，未执行。`;
          trace.result = text;
          trace.endedAt = endedAt;
          trace.durationMs = durationMs(startedAt, endedAt);
          streamStats.add(stepIdx, 'tool_result', 'toolOutputChars', charCount(text), activeTool);
          await emit(step.id, {
            type: 'tool_result',
            step: stepIdx,
            id: call.id,
            name: call.name,
            result: text,
            startedAt,
            endedAt,
            durationMs: trace.durationMs,
          });
          const toolMsg = { role: 'tool' as const, content: text, toolCallId: call.id };
          ctx.add(toolMsg);
          ctx.setLastDbId(await store.addMessage(scope, threadId, runId, step.id, toolMsg));
          const signature = toolSignature(call.name, !parsedArgs.ok
            ? { _invalidArgs: call.arguments.slice(0, 240) }
            : { _blockedBySpace: true });
          recentToolSignatures.push(signature);
          if (recentToolSignatures.length > 6) recentToolSignatures.shift();
          recentFailures.push(`${signature}:${text.slice(0, 240)}`);
          if (recentFailures.length > 6) recentFailures.shift();
          continue;
        }

        if (call.name === ASK_USER_TOOL_NAME) {
          const spec = normalizeAskUserSpec(args);
          const endedAt = new Date().toISOString();
          const text = `正在等待用户回答。问题：${spec.question}`;
          trace.result = text;
          trace.endedAt = endedAt;
          trace.durationMs = durationMs(startedAt, endedAt);
          streamStats.add(stepIdx, 'tool_result', 'toolOutputChars', charCount(text), activeTool);
          await emit(step.id, {
            type: 'tool_result',
            step: stepIdx,
            id: call.id,
            name: call.name,
            result: text,
            startedAt,
            endedAt,
            durationMs: trace.durationMs,
          });
          await emit(step.id, { type: 'user_question', step: stepIdx, question: spec.question, toolCallId: call.id, spec });
          const toolMsg = { role: 'tool' as const, content: text, toolCallId: call.id };
          ctx.add(toolMsg);
          ctx.setLastDbId(await store.addMessage(scope, threadId, runId, step.id, toolMsg));
          await store.setRunStatus(scope, runId, 'waiting_for_user');
          return;
        }

        let toolStage: StreamStage = 'tool_running';
        const stopToolHeartbeat = streamStats.startHeartbeat(stepIdx, () => toolStage, () => activeTool);
        let result: ToolResult = await withSpan(
          'execute_tool',
          { 'gen_ai.tool.name': call.name, 'tool.call_id': call.id },
          async (span) => {
            try {
              if (call.name === 'skill_activate') {
                try {
                  const activation = await activateIndexedSkill(String(args.id ?? args.name ?? ''));
                  const out = { text: await applySkillActivation(activation) };
                  span.setAttribute('tool.result.length', out.text.length);
                  return out;
                } catch (err) {
                  const out = { text: `激活 skill 失败：${(err as Error).message}` };
                  span.setAttribute('tool.result.length', out.text.length);
                  return out;
                }
              }
              if (call.name === 'mcp_activate') {
                try {
                  const out = { text: await applyMcpActivation(String(args.id ?? '')) };
                  span.setAttribute('tool.result.length', out.text.length);
                  return out;
                } catch (err) {
                  const out = { text: `激活 MCP 失败：${(err as Error).message}` };
                  span.setAttribute('tool.result.length', out.text.length);
                  return out;
                }
              }
              if (call.name === SUBAGENT_RUN_TOOL_NAME) {
                const out = await startSubagent(args, step.id, stepIdx, startedAt);
                span.setAttribute('tool.result.length', out.text.length);
                return out;
              }
              if (call.name === SUBAGENT_POLL_TOOL_NAME) {
                const out = await pollSubagent(args);
                span.setAttribute('tool.result.length', out.text.length);
                return out;
              }
              if (call.name === SUBAGENT_LIST_TOOL_NAME) {
                const out = await listSubagents(args);
                span.setAttribute('tool.result.length', out.text.length);
                return out;
              }
              const command = commandFromToolCall(call.name, args);
              if (
                command
                && requiresDatabaseAccess(command)
                && !requestActiveSkillNames.has(DATABASE_ACCESS_SKILL_NAME)
              ) {
                const out = { text: '数据库命令未执行：请先调用 skill_activate，并传入 id/name "database-access" 激活操作规范。' };
                span.setAttribute('tool.result.length', out.text.length);
                return out;
              }
              const out = await runTool(call.name, args, {
                scope,
                settings: toolSettings,
                env: envForStep(step.id),
                threadId,
                runId,
                stepId: step.id,
                step: stepIdx,
                mcpSettings,
                activeMcpServerIds: requestMcpServerIds,
                abortSignal: cancellationSignal,
                mcpCallTool: async (name, input, settings, context) => {
                  const parsed = parseMcpToolName(name);
                  if (parsed && runtimeResources.businessPluginHandle?.mcpServers.some((server) => server.id === parsed.serverId)) {
                    await refreshBusinessMcpServers(step.id);
                  }
                  return mcpSession.callTool(name, input, settings, context);
                },
              });
              span.setAttribute('tool.result.length', out.text.length);
              return out;
            } finally {
              stopToolHeartbeat();
            }
          },
        );
        cancellationSignal.throwIfAborted();
        if (call.name === 'update_plan') {
          goal = mergeGoal(goal, parseGoalPatch(args));
          await store.setGoalState(scope, runId, goal);
          const completeGoal = renderGoal(goal);
          ctx.setGoal(completeGoal);
          result = { ...result, text: completeGoal };
          if (goal.plan.length) await emit(step.id, { type: 'plan_update', step: stepIdx, goal });
        }
        const endedAt = new Date().toISOString();
        trace.result = result.text;
        trace.endedAt = endedAt;
        trace.durationMs = durationMs(startedAt, endedAt);
        toolStage = 'tool_result';
        streamStats.add(stepIdx, 'tool_result', 'toolOutputChars', charCount(result.text), activeTool);
        await emit(step.id, {
          type: 'tool_result',
          step: stepIdx,
          id: call.id,
          name: call.name,
          result: result.text,
          startedAt,
          endedAt,
          durationMs: trace.durationMs,
        });

        // 图片内容不直接落库；保存受控引用，下一次请求（包括重启恢复）再从 workspace 重读。
        const toolMsg = {
          role: 'tool' as const,
          content: appendImageAttachmentTokens(result.text, result.contentParts, call.id),
          toolCallId: call.id,
        };
        ctx.add(toolMsg);
        ctx.setLastDbId(await store.addMessage(scope, threadId, runId, step.id, toolMsg));

        const signature = toolSignature(call.name, args);
        if (!isPendingSubagentWait(call.name, result.text)) {
          recentToolSignatures.push(signature);
          if (recentToolSignatures.length > 6) recentToolSignatures.shift();
        }
        const failure = /^(工具 .* 抛出异常|工具策略已阻止|未知工具：)/.test(result.text)
          ? `${signature}:${result.text.slice(0, 240)}`
          : '';
        if (failure) {
          recentFailures.push(failure);
          if (recentFailures.length > 6) recentFailures.shift();
        }

      }
      const guardHit = detectLoopGuard(recentToolSignatures, recentFailures);
      if (guardHit) {
        if (spaceConfig?.mode === 'external') {
          if (await prepareExternalStop(step.id, stepIdx) === 'continue') continue;
          await emit(step.id, { type: 'progress_stalled', step: stepIdx, reason: guardHit.reason, question: guardHit.question });
          await emit(step.id, { type: 'error', step: stepIdx, message: guardHit.reason });
          await store.setRunStatus(scope, runId, 'error', { error: guardHit.reason });
          return;
        }
        await emit(step.id, { type: 'progress_stalled', step: stepIdx, reason: guardHit.reason, question: guardHit.question });
        await emit(step.id, { type: 'user_question', step: stepIdx, question: guardHit.question });
        await store.setRunStatus(scope, runId, 'waiting_for_user');
        return;
      }
    }

    const message = `Reached hard step cap (${hardStepCap}) without a final answer.`;
    await emit(null, { type: 'error', step: hardStepCap, message });
    await store.setRunStatus(scope, runId, 'error', { error: message });
  }
}
