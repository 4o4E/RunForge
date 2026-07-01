import type { AgentEvent, RunStatus } from './agent.js';
import type { GoalState } from './goal.js';

export interface Thread {
  id: string;
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

export interface RunBranchInput {
  input?: string;
  modelRef?: string | null;
}

export interface ThreadDetailResponse {
  thread: Thread;
  runs: RunWithEvents[];
  notices: ThreadNotice[];
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
