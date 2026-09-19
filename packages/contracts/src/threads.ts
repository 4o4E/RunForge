import type { AgentEvent, RunStatus } from './agent.js';
import type { GoalState } from './goal.js';
import type { SpaceSummary } from './spaces.js';

export interface Thread {
  id: string;
  space_id: string;
  source_type: 'web' | 'external';
  source_caller_id: string | null;
  source_ref: Record<string, unknown>;
  title: string | null;
  fallback_title?: string | null;
  active_run_id: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadUpdateInput {
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
  activeRunId?: string | null;
}

export interface ThreadNotice {
  id: number;
  thread_id: string;
  kind: string;
  message: string;
  title?: string | null;
  linked_thread_id: string | null;
  linked_run_id: string | null;
  created_at: string;
}

export interface RunWithEvents {
  id: string;
  thread_id: string;
  parent_run_id: string | null;
  status: RunStatus;
  input: string;
  model_ref?: string | null;
  output: string | null;
  error: string | null;
  goal_state?: GoalState | null;
  created_at: string;
  updated_at: string;
  events: AgentEvent[];
}

export interface ThreadContextToolCall {
  id: string;
  name: string;
  /** 仅在显式 Debug 模式下返回。 */
  arguments?: string;
  argumentChars: number;
}

export interface ThreadContextMessage {
  id: number;
  run_id: string;
  step_id: string | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  tool_calls: ThreadContextToolCall[];
  tool_call_id: string | null;
  collapsed: 'masked' | 'summarized' | null;
  summary_of: number[];
  content_chars: number;
  /** 仅在显式 Debug 模式下返回；默认详情接口不会携带原文。 */
  content?: string | null;
  encrypted_reasoning_count?: number;
  encrypted_reasoning_chars?: number;
  created_at: string;
}

export interface StepContextContentPart {
  type: 'text' | 'image';
  text?: string;
  mimeType?: string;
  path?: string;
  name?: string;
}

export interface StepContextToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StepContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  contentParts?: StepContextContentPart[];
  toolCalls?: StepContextToolCall[];
  toolCallId?: string;
  collapsed?: 'masked' | 'summarized';
  providerState?: {
    reasoningParts: number;
    encryptedChars: number;
  };
}

export interface StepContextTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StepContextSnapshotSummary {
  stepId: string;
  runId: string;
  step: number;
  messageCount: number;
  toolCount: number;
  createdAt: string;
}

/** 每个 Agent step 调用模型前固定的实际逻辑上下文。 */
export interface StepContextSnapshotView extends StepContextSnapshotSummary {
  messages: StepContextMessage[];
  tools: StepContextTool[];
}

export interface ThreadStepContextsResponse {
  threadId: string;
  activeRunId: string | null;
  contexts: StepContextSnapshotSummary[];
}

export interface RunBranchInput {
  input?: string;
  modelRef?: string | null;
}

export interface ThreadDetailResponse {
  thread: Thread;
  space: SpaceSummary;
  readOnly: boolean;
  runs: RunWithEvents[];
  notices: ThreadNotice[];
  context_messages: ThreadContextMessage[];
  debug: boolean;
}

export interface ThreadForkResponse {
  thread: Thread;
  activeRun: RunWithEvents;
}

export interface ThreadSearchResult {
  thread_id: string;
  thread_title: string | null;
  run_id: string;
  message_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface ThreadSearchResponse {
  query: string;
  results: ThreadSearchResult[];
}

export type SubagentRunStatus = 'running' | 'done' | 'error';

export interface SubagentRun {
  id: string;
  parent_run_id: string;
  parent_step_id: string | null;
  workflow_id: string | null;
  stage_id: string | null;
  runtime_profile_id: string | null;
  status: SubagentRunStatus;
  task_assignment: Record<string, unknown>;
  skill_names: string[];
  output: string | null;
  error: string | null;
  usage: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
