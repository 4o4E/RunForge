import { config } from '../config.js';
import { getConfiguredProvider } from '../llm/index.js';
import type { LlmMessage, LlmUsage, Provider } from '../llm/types.js';
import { parseToolArguments } from '../llm/toolArgs.js';
import { runTool, toolSchemas } from '../tools/registry.js';
import { ContextManager } from './context.js';
import { activateSkill, activeAllowedTools, loadSkillIndex, renderSkillCatalog, renderSkillSystemRules } from '../skills/registry.js';
import type { SkillIndexItem, SkillActivation } from '../skills/registry.js';
import { createWorkloadToken, listDatasources, listPermissionProfiles } from '../datasources/accountPool.js';
import { canReportGoal, finishGoal, initGoal, mergeGoal, parseGoalPatch, renderGoal, reportBlockedMessage } from './goal.js';
import { runBus } from './bus.js';
import type { AgentEvent } from './types.js';
import { store as defaultStore } from '../store/index.js';
import type { Store } from '../store/types.js';
import { getToolSettings } from '../settings.js';
import type { ToolSettings } from '../settings.js';
import { withSpan } from '../telemetry.js';
import type { AskUserAnswer, AskUserMode, AskUserOption, AskUserSpec, StreamStage, StreamStats } from './types.js';
import { renderRuntimeContext } from './context.js';
import { shellManager } from '../shell/manager.js';
import { requiresDatabaseAccess } from '../tools/databaseAccessGuard.js';
import type { SubagentRunRow } from '../store/types.js';
import { loadWorkflowIndex, renderWorkflowCatalog, renderWorkflowSystemRules } from '../workflows/registry.js';

const ASK_USER_TOOL_NAME = 'ask_user';
const DATABASE_ACCESS_SKILL_NAME = 'database-access';
const SUBAGENT_RUN_TOOL_NAME = 'subagent_run';
const SUBAGENT_POLL_TOOL_NAME = 'subagent_poll';
const SUBAGENT_LIST_TOOL_NAME = 'subagent_list';
const STREAM_STATS_POINTS = 24;
const STREAM_STATS_MIN_INTERVAL_MS = 250;
const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|key|credential|connectionurl)/i;

export interface ExecutorDeps {
  provider: Provider;
  store: Store;
  publish: (runId: string, event: AgentEvent) => void;
  /** 防失控兜底，不是主要流程控制；配置见 config.agent.hardStepCap。 */
  hardStepCap: number;
  stream: boolean;
  resume: boolean;
  toolSettings?: ToolSettings;
  databaseRuntimeEnv?: (runId: string) => Promise<DatabaseRuntimeEnv>;
}

interface DatabaseRuntimeEnv {
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

async function defaultDeps(overrides: Partial<ExecutorDeps>, modelRef?: string | null): Promise<ExecutorDeps> {
  const configured = overrides.provider ? null : await getConfiguredProvider(modelRef ?? undefined);
  return {
    provider: overrides.provider ?? configured!.provider,
    store: overrides.store ?? defaultStore,
    publish: overrides.publish ?? ((runId, event) => runBus.publish(runId, event)),
    hardStepCap: overrides.hardStepCap ?? config.agent.hardStepCap,
    stream: overrides.stream ?? configured?.stream ?? config.llm.stream,
    resume: overrides.resume ?? false,
    toolSettings: overrides.toolSettings,
    databaseRuntimeEnv: overrides.databaseRuntimeEnv,
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

function safeToolCallArguments(rawArguments: string): string {
  const parsed = parseToolArguments(rawArguments || '{}');
  if (!parsed.ok) return rawArguments;
  return JSON.stringify(redactToolArgs(parsed.args));
}

function redactToolCalls(toolCalls: LlmMessage['toolCalls']): LlmMessage['toolCalls'] {
  return toolCalls?.map((call) => ({ ...call, arguments: safeToolCallArguments(call.arguments) }));
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

function commandFromToolCall(name: string, args: unknown): string | null {
  if (name !== 'shell' && name !== 'shell_exec') return null;
  const command = args && typeof args === 'object' ? (args as Record<string, unknown>).command : null;
  return typeof command === 'string' ? command : null;
}

async function createDefaultDatabaseRuntimeEnv(runId: string): Promise<DatabaseRuntimeEnv> {
  const activeDatasources = (await listDatasources()).filter((datasource) => datasource.enabled && datasource.status === 'active');
  const allowedDatasourceIds = activeDatasources.map((datasource) => datasource.id);
  const created = await createWorkloadToken({
    runId,
    skillId: 'runtime:run',
    allowedDatasourceIds,
  });

  const env: Record<string, string> = {
    DB_WORKLOAD_TOKEN: created.token,
    MY_AGENT_RUNTIME_API_BASE: runtimeApiBase(),
    DATASOURCE_PROFILE: 'readonly',
  };

  if (activeDatasources.length === 1) {
    const datasource = activeDatasources[0];
    env.DATASOURCE_ID = datasource.id;
    const profiles = await listPermissionProfiles(datasource.id);
    const readonly = profiles.find((profile) => profile.name === 'readonly');
    env.DATASOURCE_PROFILE = readonly?.name ?? profiles[0]?.name ?? 'readonly';
  }

  const visible = [
    'DB_WORKLOAD_TOKEN=已注入',
    `MY_AGENT_RUNTIME_API_BASE=${env.MY_AGENT_RUNTIME_API_BASE}`,
    env.DATASOURCE_ID ? `DATASOURCE_ID=${env.DATASOURCE_ID}` : 'DATASOURCE_ID=未自动选择',
    `DATASOURCE_PROFILE=${env.DATASOURCE_PROFILE}`,
    `allowedDatasourceIds=${allowedDatasourceIds.length ? allowedDatasourceIds.join(',') : '无'}`,
  ];

  return {
    env,
    summary: [
      '数据库访问运行环境（run 级）:',
      ...visible.map((item) => `- ${item}`),
      '- DB_WORKLOAD_TOKEN 只是换取本次 run 短期数据库凭证的令牌，不是数据库密码。',
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
  return (process.env.MY_AGENT_RUNTIME_API_BASE ?? `http://127.0.0.1:${config.port}/api/runtime`).replace(/\/+$/, '');
}

/**
 * 核心 agent 循环，按 thread → run → step 组织。
 *
 * 一个 run 对应一次用户输入；每次循环是一轮 LLM 调用及其工具调用。
 * 运行前会加载同一 thread 的历史消息，让 agent 具备多轮记忆。
 * 所有依赖都可注入，便于在没有 PG/网络的情况下做单元测试。
 */
export async function executeRun(runId: string, overrides: Partial<ExecutorDeps> = {}): Promise<void> {
  const store = overrides.store ?? defaultStore;
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run 不存在：${runId}`);
  let deps: ExecutorDeps;
  try {
    deps = await defaultDeps({ ...overrides, store }, run.model_ref);
  } catch (err) {
    const message = (err as Error).message;
    const publish = overrides.publish ?? ((targetRunId, event) => runBus.publish(targetRunId, event));
    const event: AgentEvent = { type: 'error', step: 0, message };
    publish(runId, event);
    await store.addEvent(runId, null, event);
    await store.setRunStatus(runId, 'error', { error: message });
    return;
  }
  const { provider, publish, hardStepCap, stream, resume } = deps;
  const initialRun = run;
  const threadId = initialRun.thread_id;
  const userInput = initialRun.input;

  const emit = async (stepId: string | null, event: AgentEvent) => {
    publish(runId, event);
    await store.addEvent(runId, stepId, event);
  };
  const emitUsageUpdate = async (stepId: string, step: number, usage?: LlmUsage) => {
    await emit(stepId, {
      type: 'usage_update',
      step,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      estContextTokens: currentCtx?.estTokens(),
      contextBudget: config.agent.contextBudget,
    });
  };

  const persistCompaction = async (stepId: string | null, compaction: Awaited<ReturnType<ContextManager['maybeCompact']>>) => {
    if (!compaction) return;
    if (compaction.summaryMessage && compaction.summarizedIds.length) {
      const summaryId = await store.addSummaryMessage(
        threadId,
        runId,
        stepId,
        compaction.summaryMessage,
        compaction.summarizedIds,
      );
      // L3 摘要在工作上下文中不是最后一条，需要按对象引用回填 DB id。
      currentCtx?.setSummaryDbId(compaction.summaryMessage, summaryId);
      await store.markMessagesCollapsed(compaction.summarizedIds, 'summarized');
    }
    const summarized = new Set(compaction.summarizedIds);
    const maskedIds = compaction.collapsedIds.filter((id) => !summarized.has(id));
    if (maskedIds.length) {
      await store.markMessagesCollapsed(maskedIds, 'masked');
    }
    await emit(stepId, { type: 'compaction', step: currentStepIdx, ...compaction.info });
  };

  let currentCtx: ContextManager | null = null;
  let currentStepIdx = 0;

  await store.setRunStatus(runId, 'running');

  try {
    await withSpan(
      'invoke_agent',
      { 'run.id': runId, 'thread.id': threadId, 'agent.hard_step_cap': hardStepCap },
      () => runLoop(),
    );
  } catch (err) {
    const message = (err as Error).message;
    await emit(null, { type: 'error', step: 0, message });
    await store.setRunStatus(runId, 'error', { error: message });
  }

  // agent 主循环保持为闭包，让 invoke_agent span 包住内部的模型调用和工具执行 span。
  async function runLoop(): Promise<void> {
    const existingMessageCount = await store.countRunMessages(runId);
    const isResume = resume || existingMessageCount > 0;
    let prior = await store.loadThreadMessages(threadId);
    let nextStepIdx = (await store.getLastStepIndex(runId)) + 1;

    // 恢复时如果进程死在工具执行中间，库里可能只有 assistant tool_call，
    // 没有对应 tool_result。这里补一条中断结果，保证 provider 消息配对完整。
    if (isResume) {
      const missing = findMissingToolResults(prior);
      for (const call of missing) {
        const content =
          `Tool call "${call.name}" was interrupted before producing a result; continue from the latest durable state or rerun it if still needed.\n` +
          `工具调用 "${call.name}" 在返回结果前被中断；请基于已持久化状态继续，必要时重新执行。`;
        await store.addMessage(threadId, runId, null, { role: 'tool', content, toolCallId: call.id });
        await emit(null, { type: 'recovery', step: Math.max(1, nextStepIdx), message: content });
      }
      if (missing.length) prior = await store.loadThreadMessages(threadId);
    }

    // Goal 锚点每步重新注入；恢复时优先使用已落库状态，避免目标回退。
    let goal = initialRun.goal_state ?? initGoal(userInput);
    if (!initialRun.goal_state) await store.setGoalState(runId, goal);
    const toolSettings = deps.toolSettings ?? (await getToolSettings());
    const toolEnv: Record<string, string> = {};
    const databaseRuntimeEnvProvider = deps.databaseRuntimeEnv ?? (deps.store === defaultStore ? createDefaultDatabaseRuntimeEnv : null);
    let databaseRuntimeSummary = '';
    if (databaseRuntimeEnvProvider) {
      try {
        const runtime = await databaseRuntimeEnvProvider(runId);
        Object.assign(toolEnv, runtime.env);
        databaseRuntimeSummary = runtime.summary;
      } catch (err) {
        databaseRuntimeSummary = `数据库访问运行环境（run 级）注入失败：${(err as Error).message}`;
      }
    }
    const skillIndex = await loadSkillIndex(toolSettings.workspaceRoot);
    const workflowIndex = await loadWorkflowIndex(toolSettings.workspaceRoot);
    const skillRuntimeContext = [renderSkillSystemRules(), renderSkillCatalog(skillIndex)].join('\n\n');
    const workflowRuntimeContext = [renderWorkflowSystemRules(), renderWorkflowCatalog(workflowIndex)].join('\n\n');
    const ctx = new ContextManager(prior, userInput, renderGoal(goal), {
      appendUserInput: !isResume,
      runtimeContext: `${renderRuntimeContext(toolSettings)}\n\n${databaseRuntimeSummary}\n\n${workflowRuntimeContext}\n\n${skillRuntimeContext}`,
    });
    currentCtx = ctx;
    if (!isResume) {
      // 新 run 只在首次执行时写入用户输入；恢复时历史里已经有这条消息。
      await store.addMessage(threadId, runId, null, { role: 'user', content: userInput });
    }

    const activeSkills: SkillIndexItem[] = [];
    const stepIds = new Map<number, string>();
    let livePersistQueue = Promise.resolve();
    const persistLiveEvent = (event: AgentEvent) => {
      const stepId = 'step' in event ? stepIds.get(event.step) ?? null : null;
      // 流式事件需要实时落库，刷新/切换会话时才能从 DB 恢复当前状态。
      livePersistQueue = livePersistQueue.then(() => store.addEvent(runId, stepId, event)).catch((err) => {
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

    const ensureDatabaseToolEnv = async (activation: SkillActivation): Promise<string> => {
      if (toolEnv.DB_WORKLOAD_TOKEN) return '数据库访问运行环境已在 run 初始化时注入；database-access skill 只提供脚本和操作规范。';

      const activeDatasources = (await listDatasources()).filter((datasource) => datasource.enabled && datasource.status === 'active');
      const allowedDatasourceIds = activeDatasources.map((datasource) => datasource.id);
      const created = await createWorkloadToken({
        runId,
        skillId: activation.skill.id,
        allowedDatasourceIds,
      });

      toolEnv.DB_WORKLOAD_TOKEN = created.token;
      toolEnv.MY_AGENT_RUNTIME_API_BASE = runtimeApiBase();
      toolEnv.DATASOURCE_PROFILE = 'readonly';

      if (activeDatasources.length === 1) {
        const datasource = activeDatasources[0];
        toolEnv.DATASOURCE_ID = datasource.id;
        const profiles = await listPermissionProfiles(datasource.id);
        const readonly = profiles.find((profile) => profile.name === 'readonly');
        toolEnv.DATASOURCE_PROFILE = readonly?.name ?? profiles[0]?.name ?? 'readonly';
      }

      const visible = [
        `DB_WORKLOAD_TOKEN=已注入`,
        `MY_AGENT_RUNTIME_API_BASE=${toolEnv.MY_AGENT_RUNTIME_API_BASE}`,
        toolEnv.DATASOURCE_ID ? `DATASOURCE_ID=${toolEnv.DATASOURCE_ID}` : 'DATASOURCE_ID=未自动选择',
        `DATASOURCE_PROFILE=${toolEnv.DATASOURCE_PROFILE}`,
        `allowedDatasourceIds=${allowedDatasourceIds.length ? allowedDatasourceIds.join(',') : '无'}`,
      ];
      return `数据库访问运行环境已注入：${visible.join('；')}。不要输出 token 或短期凭证。`;
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
    ): Promise<void> => {
      const task = optionalString(args.task) ?? '未记录';
      const workflowId = optionalString(args.workflowId);
      const stageId = optionalString(args.stageId);
      const stageGoal = optionalString(args.stageGoal);
      const runtimeProfileId = optionalString(args.runtimeProfileId);
      const modelRef = optionalString(args.modelRef);
      const skillNames = stringList(args.skillNames);
      const taskAssignment = row.task_assignment;

      try {
        const skillMessages: string[] = [];
        for (const name of skillNames) {
          try {
            const activation = await activateSkill(toolSettings.workspaceRoot, name);
            skillMessages.push(activation.systemMessage);
          } catch (err) {
            skillMessages.push(`Skill "${name}" 加载失败：${(err as Error).message}`);
          }
        }

        const messages: LlmMessage[] = [
          {
            role: 'system',
            content: [
              '你是当前 thread 内部的异步只读推理型 subagent。',
              'You are an asynchronous read-only reasoning subagent inside the current thread.',
              '你不会直接修改文件、调用工具或写入长期 memory；你只基于输入材料、workflow stage 和 skill 给出结构化结论。',
              'Do not claim that you changed files or ran tools. Return evidence, risks, and next-step recommendations.',
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
              '请输出：结论、关键证据、风险/不确定性、建议下一步。',
            ].join('\n'),
          },
        ];

        const subagentProvider = modelRef ? (await getConfiguredProvider(modelRef)).provider : provider;
        const result = await subagentProvider.complete(messages, []);
        const output = result.content?.trim() || 'subagent 未返回文本结果。';
        const endedAt = new Date().toISOString();
        await store.finishSubagentRun(row.id, {
          status: 'done',
          output,
          usage: result.usage ? { ...result.usage } : null,
        });
        await emit(stepId, {
          type: 'subagent_finished',
          step: stepIdx,
          subagentRunId: row.id,
          output,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          startedAt,
          endedAt,
          durationMs: durationMs(startedAt, endedAt),
        });
      } catch (err) {
        const error = (err as Error).message;
        const endedAt = new Date().toISOString();
        await store.finishSubagentRun(row.id, { status: 'error', error });
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

      const row = await store.createSubagentRun({
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

      void completeSubagent(row, args, stepId, stepIdx, toolStartedAt);
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
      const row = await store.getSubagentRun(subagentRunId);
      if (!row) return { text: `没有找到 subagentRunId: ${subagentRunId}` };
      const visibleRows = await store.listSubagentRunsByThread(threadId);
      if (!visibleRows.some((item) => item.id === row.id)) {
        return { text: `当前 thread 无权读取 subagentRunId: ${subagentRunId}` };
      }
      return { text: renderSubagentRow(row, true) };
    };

    const listSubagents = async (args: Record<string, unknown>): Promise<{ text: string }> => {
      const rawStatus = optionalString(args.status);
      const status = rawStatus === 'running' || rawStatus === 'done' || rawStatus === 'error' ? rawStatus : null;
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 20;
      const limit = Math.min(Math.max(rawLimit, 1), 50);
      let rows = await store.listSubagentRunsByThread(threadId);
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
      const current = await store.getRun(runId);
      if (current?.status === 'canceling') {
        try {
          await shellManager.killRunCommands(runId, 'run_cancel');
        } catch (err) {
          const message = (err as Error).message;
          if (!message.includes('relation "shell_commands" does not exist')) {
            console.warn(`shell command cleanup during cancel failed: ${message}`);
          }
        }
        await emit(null, { type: 'error', step: stepIdx, message: '用户已取消 run。' });
        await store.setRunStatus(runId, 'canceled');
        return;
      }

      const step = await store.createStep(runId, stepIdx);
      stepIds.set(stepIdx, step.id);
      await emit(step.id, { type: 'step_start', step: stepIdx });
      streamStats.mark(stepIdx, 'llm_waiting', undefined, true);

      // 模型调用前先控制工作上下文大小；mask 决策会落库，窗口丢弃只留在内存。
      const compaction = await ctx.maybeCompact(provider);
      await persistCompaction(step.id, compaction);
      // 每个 step 调模型前先推估算上下文，避免等待模型返回期间占用为空。
      await emitUsageUpdate(step.id, stepIdx);

      // 支持流式时实时发布增量；完整文本只在末尾落库，历史回放更紧凑。
      let result;
      let liveStreamed = false;
      let publishedDelta = false;
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
        const tools = toolSchemas(activeAllowedTools(activeSkills));
        if (stream && provider.completeStream) {
          try {
            result = await provider.completeStream(ctx.all(), tools, (d) => {
              publishedDelta = true;
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
            });
            liveStreamed = true;
          } catch (err) {
            if (publishedDelta) throw err; // 已经输出部分内容时无法干净回退。
            // 还没输出时走非流式路径，由 provider 自己处理重试。
          }
        }
        if (!result) result = await provider.complete(ctx.all(), tools);
      } finally {
        stopLlmHeartbeat();
      }
      await livePersistQueue;
      const llmEndedAt = new Date().toISOString();

      // 用真实 token 用量校准估算器，供下一次压缩判断使用。
      ctx.recordUsage(result.usage);
      if (result.usage) await emitUsageUpdate(step.id, stepIdx, result.usage);

      const { content, reasoning, toolCalls } = result;
      if (!liveStreamed) {
        if (reasoning) streamStats.add(stepIdx, 'reasoning', 'reasoningChars', charCount(reasoning), undefined);
        if (content) streamStats.add(stepIdx, 'output', 'outputChars', charCount(content), undefined);
      }

      // reasoning 只给前端展示，不回填到模型上下文。
      if (reasoning) {
        const startedAt = reasoningStartedAt ?? llmStartedAt;
        const timing = { startedAt, endedAt: llmEndedAt, durationMs: durationMs(startedAt, llmEndedAt) };
        const ev = { type: 'reasoning' as const, step: stepIdx, text: reasoning, ...timing };
        if (liveStreamed && persistedLiveReasoning) {
          await emit(step.id, { type: 'reasoning_timing', step: stepIdx, ...timing });
        } else if (liveStreamed) {
          await store.addEvent(runId, step.id, ev);
          await emit(step.id, { type: 'reasoning_timing', step: stepIdx, ...timing });
        } else {
          await emit(step.id, ev);
        }
      }

      const assistantMsg = { role: 'assistant' as const, content, toolCalls: redactToolCalls(toolCalls.length ? toolCalls : undefined) };
      ctx.add(assistantMsg);
      ctx.setLastDbId(await store.addMessage(threadId, runId, step.id, assistantMsg));

      if (content && (toolCalls.length || liveStreamed) && !persistedLiveContent) {
        const ev = { type: 'llm_delta' as const, step: stepIdx, text: content };
        if (liveStreamed) await store.addEvent(runId, step.id, ev);
        else await emit(step.id, ev);
      }

      if (!toolCalls.length) {
        const finalText = content?.trim() ?? '';
        if (finalText && canReportGoal(goal)) {
          goal = finishGoal(goal);
          await store.setGoalState(runId, goal);
          ctx.setGoal(renderGoal(goal));
          if (goal.plan.length) await emit(step.id, { type: 'plan_update', step: stepIdx, goal });
          await persistCompaction(step.id, ctx.compactForHistory());
          streamStats.mark(stepIdx, 'done', undefined, true);
          await livePersistQueue;
          await emit(step.id, { type: 'final', step: stepIdx, output: finalText });
          await store.setRunStatus(runId, 'done', { output: finalText });
          return;
        }

        noActionTurns += 1;
        if (noActionTurns >= 3) {
          const reason = finalText
            ? `连续 ${noActionTurns} 个 step 输出了最终文本，但计划没有进入可汇报状态。`
            : `连续 ${noActionTurns} 个 step 没有工具调用，也没有有效最终汇报。`;
          const question = blockedQuestion(reason);
          await emit(step.id, { type: 'progress_stalled', step: stepIdx, reason, question });
          await emit(step.id, { type: 'user_question', step: stepIdx, question });
          await store.setRunStatus(runId, 'waiting_for_user');
          return;
        }
        ctx.add({
          role: 'system',
          content: reportBlockedMessage(goal),
        });
        continue;
      }
      noActionTurns = 0;

      const toolTraces: ToolTrace[] = [];
      const pendingSkillSystemMessages: LlmMessage[] = [];
      const applySkillActivation = async (activation: SkillActivation) => {
        const alreadyActive = activeSkills.some((skill) => skill.id === activation.skill.id);
        if (!alreadyActive) activeSkills.push(activation.skill);
        let runtimeEnvMessage = '';
        if (activation.skill.name === DATABASE_ACCESS_SKILL_NAME) {
          try {
            runtimeEnvMessage = `\n\n${await ensureDatabaseToolEnv(activation)}`;
          } catch (err) {
            runtimeEnvMessage = `\n\n数据库访问运行环境注入失败：${(err as Error).message}`;
          }
        }
        const skillMsg = { role: 'system' as const, content: `${activation.systemMessage}${runtimeEnvMessage}` };
        pendingSkillSystemMessages.push(skillMsg);
        await emit(step.id, {
          type: 'skill_activated',
          step: stepIdx,
          skillId: activation.skill.id,
          name: activation.skill.name,
          source: activation.skill.source,
          root: activation.skill.root,
          readonly: activation.skill.readonly,
          hash: activation.skill.hash,
          allowedTools: activation.skill.allowedTools,
        });
      };

      // 执行模型请求的每个工具，并把结果回填给模型。
      for (const call of toolCalls) {
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

        if (!parsedArgs.ok) {
          const endedAt = new Date().toISOString();
          const text = `工具参数无效，未执行 ${call.name}：${parsedArgs.error}`;
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
          ctx.setLastDbId(await store.addMessage(threadId, runId, step.id, toolMsg));
          const signature = toolSignature(call.name, { _invalidArgs: call.arguments.slice(0, 240) });
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
          ctx.setLastDbId(await store.addMessage(threadId, runId, step.id, toolMsg));
          for (const msg of pendingSkillSystemMessages) {
            ctx.add(msg);
          }
          await store.setRunStatus(runId, 'waiting_for_user');
          return;
        }

        let toolStage: StreamStage = 'tool_running';
        const stopToolHeartbeat = streamStats.startHeartbeat(stepIdx, () => toolStage, () => activeTool);
        const activatedSkill: { value?: SkillActivation } = {};
        let result = await withSpan(
          'execute_tool',
          { 'gen_ai.tool.name': call.name, 'tool.call_id': call.id },
          async (span) => {
            try {
              if (call.name === 'skill_activate') {
                try {
                  activatedSkill.value = await activateSkill(toolSettings.workspaceRoot, String(args.name ?? ''));
                } catch (err) {
                  const out = { text: `激活 skill 失败：${(err as Error).message}` };
                  span.setAttribute('tool.result.length', out.text.length);
                  return out;
                }
                const out = { text: `已激活 skill ${activatedSkill.value.skill.name}。` };
                span.setAttribute('tool.result.length', out.text.length);
                return out;
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
                && !activeSkills.some((skill) => skill.name === DATABASE_ACCESS_SKILL_NAME)
              ) {
                try {
                  const activation = await activateSkill(toolSettings.workspaceRoot, DATABASE_ACCESS_SKILL_NAME);
                  await applySkillActivation(activation);
                } catch (err) {
                  const out = { text: `自动激活 database-access 失败：${(err as Error).message}` };
                  span.setAttribute('tool.result.length', out.text.length);
                  return out;
                }
              }
              const out = await runTool(call.name, args, {
                settings: toolSettings,
                env: toolEnv,
                threadId,
                runId,
                stepId: step.id,
                step: stepIdx,
              });
              span.setAttribute('tool.result.length', out.text.length);
              return out;
            } finally {
              stopToolHeartbeat();
            }
          },
        );
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

        const toolMsg = { role: 'tool' as const, content: result.text, toolCallId: call.id };
        ctx.add(toolMsg);
        ctx.setLastDbId(await store.addMessage(threadId, runId, step.id, toolMsg));

        const activation = activatedSkill.value;
        if (activation) await applySkillActivation(activation);

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

        // update_plan 会刷新已落库目标锚点，并同步重新注入上下文。
        if (call.name === 'update_plan') {
          goal = mergeGoal(goal, parseGoalPatch(args));
          await store.setGoalState(runId, goal);
          ctx.setGoal(renderGoal(goal));
          if (goal.plan.length) await emit(step.id, { type: 'plan_update', step: stepIdx, goal });
        }

      }

      // 同一个 assistant turn 里可能有多个 tool_call。Provider 要求这些调用的
      // tool_result 连续出现，所以 skill 的 system 注入必须等本轮工具结果全部回填后再追加。
      for (const msg of pendingSkillSystemMessages) {
        ctx.add(msg);
      }

      const guardHit = detectLoopGuard(recentToolSignatures, recentFailures);
      if (guardHit) {
        await emit(step.id, { type: 'progress_stalled', step: stepIdx, reason: guardHit.reason, question: guardHit.question });
        await emit(step.id, { type: 'user_question', step: stepIdx, question: guardHit.question });
        await store.setRunStatus(runId, 'waiting_for_user');
        return;
      }
    }

    const message = `Reached hard step cap (${hardStepCap}) without a final answer.`;
    await emit(null, { type: 'error', step: hardStepCap, message });
    await store.setRunStatus(runId, 'error', { error: message });
  }
}
