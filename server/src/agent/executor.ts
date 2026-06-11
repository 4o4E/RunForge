import { config } from '../config.js';
import { getProvider } from '../llm/index.js';
import type { Provider } from '../llm/types.js';
import { runTool, toolSchemas } from '../tools/registry.js';
import { Context } from './context.js';
import { runBus } from './bus.js';
import type { AgentEvent } from './types.js';
import { store as defaultStore } from '../store/index.js';
import type { Store } from '../store/types.js';
import { withSpan } from '../telemetry.js';

export interface ExecutorDeps {
  provider: Provider;
  store: Store;
  publish: (runId: string, event: AgentEvent) => void;
  maxSteps: number;
  stream: boolean;
}

function defaultDeps(): ExecutorDeps {
  return {
    provider: getProvider(),
    store: defaultStore,
    publish: (runId, event) => runBus.publish(runId, event),
    maxSteps: config.agent.maxSteps,
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
  const { provider, store, publish, maxSteps, stream } = deps;

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
      { 'run.id': runId, 'thread.id': threadId, 'agent.max_steps': maxSteps },
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
    const ctx = new Context(prior, userInput);
    // Persist the user turn (no step yet).
    await store.addMessage(threadId, runId, null, { role: 'user', content: userInput });

    const tools = toolSchemas();

    for (let stepIdx = 1; stepIdx <= maxSteps; stepIdx++) {
      const step = await store.createStep(runId, stepIdx);
      await emit(step.id, { type: 'step_start', step: stepIdx });

      // Stream when supported: publish incremental deltas live (bus only); the
      // consolidated text is persisted once at the end so replay stays compact.
      let result;
      let liveStreamed = false;
      let publishedDelta = false;
      if (stream && provider.completeStream) {
        try {
          result = await provider.completeStream(ctx.all(), tools, (d) => {
            publishedDelta = true;
            if (d.reasoning) publish(runId, { type: 'reasoning', step: stepIdx, text: d.reasoning });
            if (d.content) publish(runId, { type: 'llm_delta', step: stepIdx, text: d.content });
          });
          liveStreamed = true;
        } catch (err) {
          if (publishedDelta) throw err; // can't cleanly recover after partial output
          // otherwise fall through to the non-streaming path (which has retry)
        }
      }
      if (!result) result = await provider.complete(ctx.all(), tools);

      const { content, reasoning, toolCalls } = result;

      // Reasoning: surfaced for display only, NOT fed back into context.
      if (reasoning) {
        const ev = { type: 'reasoning' as const, step: stepIdx, text: reasoning };
        if (liveStreamed) await store.addEvent(runId, step.id, ev);
        else await emit(step.id, ev);
      }

      const assistantMsg = { role: 'assistant' as const, content, toolCalls: toolCalls.length ? toolCalls : undefined };
      ctx.add(assistantMsg);
      await store.addMessage(threadId, runId, step.id, assistantMsg);

      if (content) {
        const ev = { type: 'llm_delta' as const, step: stepIdx, text: content };
        if (liveStreamed) await store.addEvent(runId, step.id, ev);
        else await emit(step.id, ev);
      }

      // No tool calls → final answer.
      if (!toolCalls.length) {
        const output = content ?? '';
        await emit(step.id, { type: 'final', step: stepIdx, output });
        await store.setRunStatus(runId, 'done', { output });
        return;
      }

      // Execute each requested tool, feed results back.
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          /* malformed JSON → empty args */
        }
        await emit(step.id, { type: 'tool_call', step: stepIdx, id: call.id, name: call.name, args });

        const result = await withSpan(
          'execute_tool',
          { 'gen_ai.tool.name': call.name, 'tool.call_id': call.id },
          async (span) => {
            const out = await runTool(call.name, args);
            span.setAttribute('tool.result.length', out.length);
            return out;
          },
        );
        await emit(step.id, { type: 'tool_result', step: stepIdx, id: call.id, name: call.name, result });

        const toolMsg = { role: 'tool' as const, content: result, toolCallId: call.id };
        ctx.add(toolMsg);
        await store.addMessage(threadId, runId, step.id, toolMsg);
      }
    }

    const message = `Reached max steps (${maxSteps}) without a final answer.`;
    await emit(null, { type: 'error', step: maxSteps, message });
    await store.setRunStatus(runId, 'error', { error: message });
  }
}
