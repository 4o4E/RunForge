import { config } from '../config.js';
import { getProvider } from '../llm/index.js';
import type { Provider } from '../llm/types.js';
import type { LlmMessage } from '../llm/types.js';
import { runTool, toolSchemas } from '../tools/registry.js';
import { ContextManager } from './context.js';
import { initGoal, mergeGoal, parseGoalPatch, renderGoal } from './goal.js';
import { runBus } from './bus.js';
import type { AgentEvent } from './types.js';
import { store as defaultStore } from '../store/index.js';
import type { Store } from '../store/types.js';
import { withSpan } from '../telemetry.js';
import type { A2uiMessage } from './a2ui.js';
import type { AskUserAnswer, AskUserMode, AskUserOption, AskUserSpec } from './types.js';

const FINISH_TOOL_NAME = 'finish_conversation';
const ASK_USER_TOOL_NAME = 'ask_user';

export interface ExecutorDeps {
  provider: Provider;
  store: Store;
  publish: (runId: string, event: AgentEvent) => void;
  /** Safety backstop, not the primary control — see config.agent.hardStepCap. */
  hardStepCap: number;
  stream: boolean;
  resume: boolean;
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

function withToolData(message: A2uiMessage, toolCalls: ToolTrace[]): A2uiMessage {
  return {
    ...message,
    dataModel: {
      ...(message.dataModel ?? {}),
      _toolCalls: toolCalls,
      _latestToolCall: toolCalls[toolCalls.length - 1] ?? null,
    },
  };
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
    note: '按默认假设继续。 / Continue with the default assumption.',
    usedRecommended: true,
  };
}

/**
 * The core agent loop, organized as thread → run → steps.
 *
 * One run = one user turn. Each loop iteration is a step (one LLM turn + its tool
 * calls). Prior thread messages are loaded so the agent has multi-turn memory.
 * All dependencies are injectable so the loop is unit-testable without PG/network.
 */
export async function executeRun(runId: string, overrides: Partial<ExecutorDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };
  const { provider, store, publish, hardStepCap, stream, resume } = deps;

  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  const initialRun = run;
  const threadId = initialRun.thread_id;
  const userInput = initialRun.input;

  const emit = async (stepId: string | null, event: AgentEvent) => {
    publish(runId, event);
    await store.addEvent(runId, stepId, event);
  };

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
    const ctx = new ContextManager(prior, userInput, renderGoal(goal), { appendUserInput: !isResume });
    if (!isResume) {
      // 新 run 只在首次执行时写入用户输入；恢复时历史里已经有这条消息。
      await store.addMessage(threadId, runId, null, { role: 'user', content: userInput });
    }

    const tools = toolSchemas();
    const recentToolSignatures: string[] = [];
    const recentFailures: string[] = [];
    let noActionTurns = 0;

    // Long tasks are bounded by completion / cancellation / context budget, not a
    // fixed step count. hardStepCap is only a runaway-loop backstop.
    for (let stepIdx = nextStepIdx; stepIdx < nextStepIdx + hardStepCap; stepIdx++) {
      // Cooperative cancellation: the cancel endpoint flips status to 'canceling';
      // we observe it at the top of each step and stop cleanly.
      const current = await store.getRun(runId);
      if (current?.status === 'canceling') {
        await emit(null, { type: 'error', step: stepIdx, message: 'Run canceled by user.' });
        await store.setRunStatus(runId, 'canceled');
        return;
      }

      const step = await store.createStep(runId, stepIdx);
      await emit(step.id, { type: 'step_start', step: stepIdx });

      // Keep the working context under budget before spending a model call. Masking
      // decisions are persisted so they survive a restart (window drops are not).
      const compaction = await ctx.maybeCompact(provider);
      if (compaction) {
        if (compaction.summaryMessage && compaction.summarizedIds.length) {
          const summaryId = await store.addSummaryMessage(
            threadId,
            runId,
            step.id,
            compaction.summaryMessage,
            compaction.summarizedIds,
          );
          ctx.setSummaryDbId(compaction.summaryMessage, summaryId);
          await store.markMessagesCollapsed(compaction.summarizedIds, 'summarized');
        }
        if (compaction.collapsedIds.length) {
          await store.markMessagesCollapsed(compaction.collapsedIds, 'masked');
        }
        await emit(step.id, { type: 'compaction', step: stepIdx, ...compaction.info });
      }

      // Stream when supported: publish incremental deltas live (bus only); the
      // consolidated text is persisted once at the end so replay stays compact.
      let result;
      let liveStreamed = false;
      let publishedDelta = false;
      const llmStartedAt = new Date().toISOString();
      let reasoningStartedAt: string | null = null;
      if (stream && provider.completeStream) {
        try {
          result = await provider.completeStream(ctx.all(), tools, (d) => {
            publishedDelta = true;
            if (d.reasoning) {
              reasoningStartedAt ??= new Date().toISOString();
              publish(runId, { type: 'reasoning', step: stepIdx, text: d.reasoning, startedAt: reasoningStartedAt });
            }
            if (d.content) publish(runId, { type: 'llm_delta', step: stepIdx, text: d.content });
          });
          liveStreamed = true;
        } catch (err) {
          if (publishedDelta) throw err; // can't cleanly recover after partial output
          // otherwise fall through to the non-streaming path (which has retry)
        }
      }
      if (!result) result = await provider.complete(ctx.all(), tools);
      const llmEndedAt = new Date().toISOString();

      // Calibrate the token estimator from real usage for the next compaction check.
      ctx.recordUsage(result.usage);

      const { content, reasoning, toolCalls } = result;

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

      const assistantMsg = { role: 'assistant' as const, content, toolCalls: toolCalls.length ? toolCalls : undefined };
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
          content:
            'finish_conversation is required before ending. Call render_ui for the final AgentUI summary first, then call finish_conversation with completed=true and progress.',
        });
        continue;
      }
      noActionTurns = 0;

      const toolTraces: ToolTrace[] = [];
      let completedOutput: string | null = null;

      // Execute each requested tool, feed results back.
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          /* malformed JSON → empty args */
        }
        const startedAt = new Date().toISOString();
        const trace: ToolTrace = { id: call.id, name: call.name, args, startedAt };
        toolTraces.push(trace);
        await emit(step.id, { type: 'tool_call', step: stepIdx, id: call.id, name: call.name, args, startedAt });

        if (call.name === ASK_USER_TOOL_NAME) {
          const spec = normalizeAskUserSpec(args);
          const endedAt = new Date().toISOString();
          const text =
            `Waiting for user answer. Question: ${spec.question}\n` +
            `正在等待用户回答。问题：${spec.question}`;
          trace.result = text;
          trace.endedAt = endedAt;
          trace.durationMs = durationMs(startedAt, endedAt);
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
          await store.setRunStatus(runId, 'waiting_for_user');
          return;
        }

        const result = await withSpan(
          'execute_tool',
          { 'gen_ai.tool.name': call.name, 'tool.call_id': call.id },
          async (span) => {
            const out = await runTool(call.name, args);
            span.setAttribute('tool.result.length', out.text.length);
            return out;
          },
        );
        const endedAt = new Date().toISOString();
        trace.result = result.text;
        trace.endedAt = endedAt;
        trace.durationMs = durationMs(startedAt, endedAt);
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

        // 结构化展示会自动附带本 step 已完成的工具参数和结果，方便 A2UI 多次补全同一界面。
        if (result.display?.type === 'a2ui') {
          const surfaceId = result.display.surfaceId ?? result.display.message.surfaceId ?? call.id;
          await emit(step.id, {
            type: 'a2ui',
            step: stepIdx,
            surfaceId,
            message: withToolData(result.display.message, toolTraces),
          });
        }

        const toolMsg = { role: 'tool' as const, content: result.text, toolCallId: call.id };
        ctx.add(toolMsg);
        ctx.setLastDbId(await store.addMessage(threadId, runId, step.id, toolMsg));

        const signature = toolSignature(call.name, args);
        recentToolSignatures.push(signature);
        if (recentToolSignatures.length > 6) recentToolSignatures.shift();
        const failure = /^(Tool .* threw|Blocked by tool policy|Unknown tool:)/.test(result.text)
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
        }

        if (call.name === FINISH_TOOL_NAME) {
          completedOutput = finishOutput(args);
        }
      }

      if (completedOutput) {
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
