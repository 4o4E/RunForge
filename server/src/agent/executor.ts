import { config } from '../config.js';
import { getProvider } from '../llm/index.js';
import type { Provider } from '../llm/types.js';
import type { LlmMessage } from '../llm/types.js';
import { parseToolArguments } from '../llm/toolArgs.js';
import { runTool, toolSchemas } from '../tools/registry.js';
import { ContextManager } from './context.js';
import { activateSkill, activeAllowedTools, loadSkillIndex, renderSkillCatalog, renderSkillSystemRules } from '../skills/registry.js';
import type { SkillIndexItem, SkillActivation } from '../skills/registry.js';
import { createWorkloadToken, listDatasources, listPermissionProfiles } from '../datasources/accountPool.js';
import { canFinishGoal, finishBlockedMessage, finishGoal, initGoal, mergeGoal, parseGoalPatch, renderGoal } from './goal.js';
import { runBus } from './bus.js';
import type { AgentEvent } from './types.js';
import { store as defaultStore } from '../store/index.js';
import type { Store } from '../store/types.js';
import { getToolSettings } from '../settings.js';
import type { ToolSettings } from '../settings.js';
import { withSpan } from '../telemetry.js';
import type { AskUserAnswer, AskUserMode, AskUserOption, AskUserSpec, StreamStage, StreamStats } from './types.js';
import { renderRuntimeContext } from './context.js';

const FINISH_TOOL_NAME = 'finish_conversation';
const ASK_USER_TOOL_NAME = 'ask_user';
const DATABASE_ACCESS_SKILL_NAME = 'database-access';
const STREAM_STATS_POINTS = 24;
const STREAM_STATS_MIN_INTERVAL_MS = 250;
const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|key|credential|connectionurl)/i;

export interface ExecutorDeps {
  provider: Provider;
  store: Store;
  publish: (runId: string, event: AgentEvent) => void;
  /** Safety backstop, not the primary control — see config.agent.hardStepCap. */
  hardStepCap: number;
  stream: boolean;
  resume: boolean;
  toolSettings?: ToolSettings;
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

class StreamStatsTracker {
  private totals = { outputChars: 0, reasoningChars: 0, toolInputChars: 0, toolOutputChars: 0, totalChars: 0 };
  private bucket = { second: Math.floor(Date.now() / 1000), chars: 0 };
  private history: number[] = [];
  private lastPublishMs = 0;

  constructor(
    private readonly runId: string,
    private readonly publish: (runId: string, event: AgentEvent) => void,
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
    this.publish(this.runId, {
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
    });
  }
}

function finishOutput(args: Record<string, unknown>): string | null {
  const progress = typeof args.progress === 'string' ? args.progress.trim() : '';
  if (args.completed !== true || !progress) return null;
  return progress;
}

function defaultDeps(): ExecutorDeps {
  return {
    provider: getProvider(),
    store: defaultStore,
    publish: (runId, event) => runBus.publish(runId, event),
    hardStepCap: config.agent.hardStepCap,
    stream: config.llm.stream,
    resume: false,
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
  const deps = { ...defaultDeps(), ...overrides };
  const { provider, store, publish, hardStepCap, stream, resume } = deps;

  const run = await store.getRun(runId);
  if (!run) throw new Error(`run 不存在：${runId}`);
  const initialRun = run;
  const threadId = initialRun.thread_id;
  const userInput = initialRun.input;

  const emit = async (stepId: string | null, event: AgentEvent) => {
    publish(runId, event);
    await store.addEvent(runId, stepId, event);
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

  // The agent loop body, kept as a closure so the invoke_agent span wraps it and
  // the AI SDK chat / execute_tool spans nest underneath.
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
    const skillIndex = await loadSkillIndex(toolSettings.workspaceRoot);
    const skillRuntimeContext = [renderSkillSystemRules(), renderSkillCatalog(skillIndex)].join('\n\n');
    const ctx = new ContextManager(prior, userInput, renderGoal(goal), {
      appendUserInput: !isResume,
      runtimeContext: `${renderRuntimeContext(toolSettings)}\n\n${skillRuntimeContext}`,
    });
    currentCtx = ctx;
    if (!isResume) {
      // 新 run 只在首次执行时写入用户输入；恢复时历史里已经有这条消息。
      await store.addMessage(threadId, runId, null, { role: 'user', content: userInput });
    }

    const activeSkills: SkillIndexItem[] = [];
    const toolEnv: Record<string, string> = {};
    const streamStats = new StreamStatsTracker(runId, publish);
    const recentToolSignatures: string[] = [];
    const recentFailures: string[] = [];
    let noActionTurns = 0;

    const ensureDatabaseToolEnv = async (activation: SkillActivation): Promise<string> => {
      if (toolEnv.DB_WORKLOAD_TOKEN) return '数据库访问运行环境已存在，本次 run 复用同一个 workload token。';

      const activeDatasources = (await listDatasources()).filter((datasource) => datasource.status === 'active');
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

    // Long tasks are bounded by completion / cancellation / context budget, not a
    // fixed step count. hardStepCap is only a runaway-loop backstop.
    for (let stepIdx = nextStepIdx; stepIdx < nextStepIdx + hardStepCap; stepIdx++) {
      currentStepIdx = stepIdx;
      // Cooperative cancellation: the cancel endpoint flips status to 'canceling';
      // we observe it at the top of each step and stop cleanly.
      const current = await store.getRun(runId);
      if (current?.status === 'canceling') {
        await emit(null, { type: 'error', step: stepIdx, message: '用户已取消 run。' });
        await store.setRunStatus(runId, 'canceled');
        return;
      }

      const step = await store.createStep(runId, stepIdx);
      await emit(step.id, { type: 'step_start', step: stepIdx });
      streamStats.mark(stepIdx, 'llm_waiting', undefined, true);

      // Keep the working context under budget before spending a model call. Masking
      // decisions are persisted so they survive a restart (window drops are not).
      const compaction = await ctx.maybeCompact(provider);
      await persistCompaction(step.id, compaction);

      // Stream when supported: publish incremental deltas live (bus only); the
      // consolidated text is persisted once at the end so replay stays compact.
      let result;
      let liveStreamed = false;
      let publishedDelta = false;
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
                publish(runId, { type: 'reasoning', step: stepIdx, text: d.reasoning, startedAt: reasoningStartedAt });
              }
              if (d.content) {
                llmStage = 'output';
                llmActiveTool = undefined;
                streamStats.add(stepIdx, 'output', 'outputChars', charCount(d.content));
                publish(runId, { type: 'llm_delta', step: stepIdx, text: d.content });
              }
            });
            liveStreamed = true;
          } catch (err) {
            if (publishedDelta) throw err; // can't cleanly recover after partial output
            // otherwise fall through to the non-streaming path (which has retry)
          }
        }
        if (!result) result = await provider.complete(ctx.all(), tools);
      } finally {
        stopLlmHeartbeat();
      }
      const llmEndedAt = new Date().toISOString();

      // Calibrate the token estimator from real usage for the next compaction check.
      ctx.recordUsage(result.usage);

      const { content, reasoning, toolCalls } = result;
      if (!liveStreamed) {
        if (reasoning) streamStats.add(stepIdx, 'reasoning', 'reasoningChars', charCount(reasoning), undefined);
        if (content) streamStats.add(stepIdx, 'output', 'outputChars', charCount(content), undefined);
      }

      // Reasoning: surfaced for display only, NOT fed back into context.
      if (reasoning) {
        const startedAt = reasoningStartedAt ?? llmStartedAt;
        const timing = { startedAt, endedAt: llmEndedAt, durationMs: durationMs(startedAt, llmEndedAt) };
        const ev = { type: 'reasoning' as const, step: stepIdx, text: reasoning, ...timing };
        if (liveStreamed) {
          await store.addEvent(runId, step.id, ev);
          await emit(step.id, { type: 'reasoning_timing', step: stepIdx, ...timing });
        } else {
          await emit(step.id, ev);
        }
      }

      const assistantMsg = { role: 'assistant' as const, content, toolCalls: redactToolCalls(toolCalls.length ? toolCalls : undefined) };
      ctx.add(assistantMsg);
      ctx.setLastDbId(await store.addMessage(threadId, runId, step.id, assistantMsg));

      if (content && toolCalls.length) {
        const ev = { type: 'llm_delta' as const, step: stepIdx, text: content };
        if (liveStreamed) await store.addEvent(runId, step.id, ev);
        else await emit(step.id, ev);
      }

      // 没有调用结束工具不算完成；把规则提醒放回上下文，让模型继续收口。
      if (!toolCalls.length) {
        noActionTurns += 1;
        if (noActionTurns >= 3) {
          const reason = `连续 ${noActionTurns} 个 step 没有工具调用，也没有 finish_conversation。`;
          const question = blockedQuestion(reason);
          await emit(step.id, { type: 'progress_stalled', step: stepIdx, reason, question });
          await emit(step.id, { type: 'user_question', step: stepIdx, question });
          await store.setRunStatus(runId, 'waiting_for_user');
          return;
        }
        ctx.add({
          role: 'system',
          content: '结束前必须调用 finish_conversation。已有 plan 时必须先调用 update_plan，把全部条目收口为 done 或 failed；失败条目要保留并标记 failed。然后用 Markdown 给出最终回答，或说明 HTML artifact 路径，再调用 finish_conversation，并设置 completed=true 和 progress。',
        });
        continue;
      }
      noActionTurns = 0;

      const toolTraces: ToolTrace[] = [];
      let completedOutput: string | null = null;
      const pendingSkillSystemMessages: LlmMessage[] = [];

      // Execute each requested tool, feed results back.
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
              const out = await runTool(call.name, args, { settings: toolSettings, env: toolEnv });
              span.setAttribute('tool.result.length', out.text.length);
              return out;
            } finally {
              stopToolHeartbeat();
            }
          },
        );
        const finishAttempt = call.name === FINISH_TOOL_NAME ? finishOutput(args) : null;
        if (finishAttempt && !canFinishGoal(goal)) {
          result = { text: finishBlockedMessage(goal) };
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

        const toolMsg = { role: 'tool' as const, content: result.text, toolCallId: call.id };
        ctx.add(toolMsg);
        ctx.setLastDbId(await store.addMessage(threadId, runId, step.id, toolMsg));

        const activation = activatedSkill.value;
        if (activation) {
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
        }

        const signature = toolSignature(call.name, args);
        recentToolSignatures.push(signature);
        if (recentToolSignatures.length > 6) recentToolSignatures.shift();
        const failure = /^(工具 .* 抛出异常|工具策略已阻止|未知工具：)/.test(result.text)
          ? `${signature}:${result.text.slice(0, 240)}`
          : '';
        if (failure) {
          recentFailures.push(failure);
          if (recentFailures.length > 6) recentFailures.shift();
        }

        // update_plan refreshes the persisted goal anchor; re-render it into context.
        if (call.name === 'update_plan') {
          goal = mergeGoal(goal, parseGoalPatch(args));
          await store.setGoalState(runId, goal);
          ctx.setGoal(renderGoal(goal));
          if (goal.plan.length) await emit(step.id, { type: 'plan_update', step: stepIdx, goal });
        }

        if (finishAttempt) {
          if (canFinishGoal(goal)) {
            completedOutput = finishAttempt;
          } else {
            ctx.add({ role: 'system', content: finishBlockedMessage(goal) });
            await emit(step.id, { type: 'recovery', step: stepIdx, message: finishBlockedMessage(goal) });
          }
        }
      }

      // 同一个 assistant turn 里可能有多个 tool_call。Provider 要求这些调用的
      // tool_result 连续出现，所以 skill 的 system 注入必须等本轮工具结果全部回填后再追加。
      for (const msg of pendingSkillSystemMessages) {
        ctx.add(msg);
      }

      if (completedOutput) {
        goal = finishGoal(goal);
        await store.setGoalState(runId, goal);
        ctx.setGoal(renderGoal(goal));
        if (goal.plan.length) await emit(step.id, { type: 'plan_update', step: stepIdx, goal });
        await persistCompaction(step.id, ctx.compactForHistory());
        streamStats.mark(stepIdx, 'done', undefined, true);
        await emit(step.id, { type: 'final', step: stepIdx, output: completedOutput });
        await store.setRunStatus(runId, 'done', { output: completedOutput });
        return;
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
