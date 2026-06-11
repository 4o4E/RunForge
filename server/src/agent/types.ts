// Agent-level types. LLM message/tool types live in ../llm/types.ts.

import type { A2uiMessage } from './a2ui.js';

export type RunStatus = 'pending' | 'running' | 'done' | 'error' | 'canceling' | 'canceled';

/**
 * Events streamed to the client and persisted. `step` is the 1-based step index
 * within a run (one LLM turn + its tool calls).
 */
export type AgentEvent =
  | { type: 'step_start'; step: number }
  | { type: 'reasoning'; step: number; text: string }
  | { type: 'llm_delta'; step: number; text: string }
  | { type: 'tool_call'; step: number; name: string; args: unknown; id: string }
  | { type: 'tool_result'; step: number; id: string; name: string; result: string }
  | { type: 'a2ui'; step: number; surfaceId: string; message: A2uiMessage }
  | { type: 'compaction'; step: number; estBefore: number; estAfter: number; masked: number; dropped: number }
  | { type: 'final'; step: number; output: string }
  | { type: 'error'; step: number; message: string };
