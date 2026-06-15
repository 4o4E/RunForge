import type { GoalState } from './goal.js';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_user'
  | 'done'
  | 'error'
  | 'canceling'
  | 'canceled';

export type AskUserMode = 'single' | 'multiple' | 'text';

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  required?: boolean;
}

export interface AskUserSpec {
  question: string;
  mode: AskUserMode;
  options: AskUserOption[];
  allowCustom: boolean;
  required: boolean;
}

export interface AskUserAnswer {
  mode: AskUserMode;
  selected: AskUserOption[];
  customOptions: string[];
  text: string;
  note: string;
  usedRecommended: boolean;
}

export interface TimedEventFields {
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}

export interface CompletedTimedEventFields {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export type StreamStage =
  | 'llm_waiting'
  | 'reasoning'
  | 'output'
  | 'tool_call'
  | 'tool_running'
  | 'tool_result'
  | 'done'
  | 'error';

export interface StreamStats {
  stage: StreamStage;
  updatedAt: string;
  activeTool?: { id: string; name: string };
  totals: {
    outputChars: number;
    reasoningChars: number;
    toolInputChars: number;
    toolOutputChars: number;
    totalChars: number;
  };
  rate: {
    charsPerSecond: number;
    history: number[];
  };
}

/** 后端给前端推送并落库的 run 事件。 */
export type AgentEvent =
  | { type: 'step_start'; step: number }
  | ({ type: 'stream_stats'; step: number } & StreamStats)
  | {
      type: 'usage_update';
      step: number;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      estContextTokens?: number;
      contextBudget?: number;
    }
  | ({ type: 'reasoning'; step: number; text: string } & Partial<TimedEventFields>)
  | ({ type: 'reasoning_timing'; step: number } & CompletedTimedEventFields)
  | { type: 'llm_delta'; step: number; text: string }
  | ({ type: 'tool_call'; step: number; name: string; args: unknown; id: string } & Pick<TimedEventFields, 'startedAt'>)
  | ({ type: 'tool_result'; step: number; id: string; name: string; result: string } & CompletedTimedEventFields)
  | {
      type: 'skill_activated';
      step: number;
      skillId: string;
      name: string;
      source: 'builtin' | 'user';
      root: string;
      readonly: boolean;
      hash: string;
      allowedTools: string[];
    }
  | { type: 'plan_update'; step: number; goal: GoalState }
  | {
      type: 'compaction';
      step: number;
      estBefore: number;
      estAfter: number;
      masked: number;
      summarized: number;
      dropped: number;
      reason?: string;
    }
  | { type: 'shell_session_opened'; step: number; sessionId: string; backend: string; workspaceRoot: string }
  | { type: 'shell_session_closed'; step: number; sessionId: string; reason?: string }
  | { type: 'shell_lease_changed'; step: number; sessionId: string; actor: 'agent' | 'user' | 'system' | null; runId?: string | null }
  | { type: 'shell_command_started'; step: number; sessionId: string; commandId: string; command: string; waitMode: 'foreground' | 'background'; startedAt: string }
  | { type: 'shell_command_output'; step: number; sessionId: string; commandId: string; stream: 'stdout' | 'stderr' | 'system'; seq: number; text: string }
  | { type: 'shell_command_timeout'; step: number; sessionId: string; commandId: string; soft: boolean; runtimeMs: number; message: string }
  | { type: 'shell_command_attention'; step: number; sessionId: string; commandId: string; attention: string; message: string }
  | { type: 'shell_command_finished'; step: number; sessionId: string; commandId: string; status: 'succeeded' | 'failed' | 'killed' | 'timed_out' | 'orphaned'; exitCode?: number | null; signal?: string | null; durationMs?: number }
  | { type: 'shell_command_killed'; step: number; sessionId: string; commandId: string; signal: string; reason?: string }
  | { type: 'user_question'; step: number; question: string; toolCallId?: string; spec?: AskUserSpec }
  | { type: 'user_answer'; step: number; answer: AskUserAnswer }
  | { type: 'user_cancel'; step: number; reason?: string }
  | { type: 'progress_stalled'; step: number; reason: string; question?: string }
  | { type: 'recovery'; step: number; message: string }
  | { type: 'final'; step: number; output: string }
  | { type: 'error'; step: number; message: string };
