import type { AgentEvent, RunStatus } from './agent.js';
import type { GoalState } from './goal.js';

export interface Thread {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunWithEvents {
  id: string;
  thread_id: string;
  status: RunStatus;
  input: string;
  output: string | null;
  error: string | null;
  goal_state?: GoalState | null;
  created_at: string;
  updated_at: string;
  events: AgentEvent[];
}

export interface ThreadDetailResponse {
  thread: Thread;
  runs: RunWithEvents[];
}
