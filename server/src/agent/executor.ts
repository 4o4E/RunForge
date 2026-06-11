import { config } from '../config.js';
import { getProvider } from '../llm/index.js';
import type { Provider } from '../llm/types.js';
import { runTool, toolSchemas } from '../tools/registry.js';
import { ContextManager } from './context.js';
import { initGoal, mergeGoal, parseGoalPatch, renderGoal } from './goal.js';
import { runBus } from './bus.js';
import type { AgentEvent } from './types.js';
import { store as defaultStore } from '../store/index.js';
import type { Store } from '../store/types.js';
import { withSpan } from '../telemetry.js';
import type { A2uiMessage } from './a2ui.js';

const FINISH_TOOL_NAME = 'finish_conversation';

export interface ExecutorDeps {
  provider: Provider;
  store: Store;
  publish: (runId: string, event: AgentEvent) => void;
  /** Safety backstop, not the primary control — see config.agent.hardStepCap. */
  hardStepCap: number;
  stream: boolean;
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
  const { provider, store, publish, hardStepCap, stream } = deps;

  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  const threadId = run.thread_id;
  const userInput = run.input;

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
    const prior = await store.loadThreadMessages(threadId);
    // Goal anchor: re-injected into the context every step so it survives compaction.
    let goal = initGoal(userInput);
    await store.setGoalState(runId, goal);
    const ctx = new ContextManager(prior, userInput, renderGoal(goal));
    // Persist the user turn (no step yet).
    await store.addMessage(threadId, runId, null, { role: 'user', content: userInput });

    const tools = toolSchemas();

    // Long tasks are bounded by completion / cancellation / context budget, not a
    // fixed step count. hardStepCap is only a runaway-loop backstop.
    for (let stepIdx = 1; stepIdx <= hardStepCap; stepIdx++) {
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
      const compaction = ctx.maybeCompact();
      if (compaction) {
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
        ctx.add({
          role: 'system',
          content:
            'finish_conversation is required before ending. Call render_ui for the final AgentUI summary first, then call finish_conversation with completed=true and progress.',
        });
        continue;
      }

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
    }

    const message = `Reached hard step cap (${hardStepCap}) without a final answer.`;
    await emit(null, { type: 'error', step: hardStepCap, message });
    await store.setRunStatus(runId, 'error', { error: message });
  }
}
