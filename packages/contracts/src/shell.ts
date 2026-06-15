export type ShellActor = 'agent' | 'user' | 'system';
export type ShellOwner = 'agent' | 'user' | 'system';
export type ShellSessionStatus = 'opening' | 'idle' | 'busy' | 'closing' | 'closed' | 'orphaned';
export type ShellCommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed' | 'timed_out' | 'orphaned';
export type ShellCommandWaitMode = 'foreground' | 'background';
export type ShellLogStream = 'stdout' | 'stderr' | 'system';

export interface ShellCommand {
  id: string;
  session_id: string;
  run_id: string | null;
  step_id: string | null;
  actor: ShellActor;
  command: string;
  cwd: string;
  wait_mode: ShellCommandWaitMode;
  status: ShellCommandStatus;
  attention: string | null;
  exit_code: number | null;
  signal: string | null;
  output_bytes: string | number;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

export interface ShellSession {
  id: string;
  thread_id: string;
  name: string;
  owner: ShellOwner;
  workspace_root: string;
  cwd: string;
  backend: string;
  status: ShellSessionStatus;
  lease_actor: ShellActor | null;
  lease_run_id: string | null;
  config_snapshot: Record<string, unknown> | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  commands?: ShellCommand[];
}

export interface ShellCommandLog {
  id: number;
  command_id: string;
  seq: number;
  stream: ShellLogStream;
  chunk: string;
  created_at: string;
}

export interface ShellCommandAttachment {
  kind: 'shell';
  commandId: string;
  shellName: string;
  name: string;
  text: string;
  size?: number;
  path?: string | null;
}
