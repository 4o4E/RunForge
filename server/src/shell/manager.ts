import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { runBus } from '../agent/bus.js';
import type { AgentEvent } from '../agent/types.js';
import { shellPathForSettings, type ToolSettings } from '../settings.js';
import { store } from '../store/index.js';
import type { Scope, ShellActor, ShellCommandRow, ShellLogStream, ShellSessionRow } from '../store/types.js';
import { buildShellSpawnSpec } from '../tools/sandbox.js';
import { shellBus } from './bus.js';
import { redactShellOutput } from './redact.js';

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_SOFT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HARD_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 5_000;
const LOG_TAIL_LIMIT = 120;

export interface ShellToolContext {
  threadId: string;
  runId?: string;
  stepId?: string;
  step?: number;
}

interface ActiveCommand {
  process: ChildProcess;
  scope: Scope;
  threadId: string;
  sessionId: string;
  commandId: string;
  workspaceRoot: string;
  cwdFile: string;
  runId?: string;
  stepId?: string;
  step: number;
  startedAt: number;
  outputBytes: number;
  cleanupPaths: string[];
  softTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
  killRequested?: boolean;
  finishStarted?: boolean;
  writeChain: Promise<void>;
  done: Promise<ShellCommandRow>;
  resolveDone: (row: ShellCommandRow) => void;
}

function deferredCommand(): Pick<ActiveCommand, 'done' | 'resolveDone'> {
  let resolveDone!: (row: ShellCommandRow) => void;
  const done = new Promise<ShellCommandRow>((resolve) => {
    resolveDone = resolve;
  });
  return { done, resolveDone };
}

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(ms: number | null): string | null {
  return ms == null ? null : new Date(Date.now() + ms).toISOString();
}

function sleep(ms: number): Promise<'timeout'> {
  return new Promise((resolveSleep) => setTimeout(() => resolveSleep('timeout'), ms));
}

function numericBytes(value: string | number): number {
  return typeof value === 'number' ? value : Number(value || 0);
}

function commandDone(status: ShellCommandRow['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'killed' || status === 'timed_out' || status === 'orphaned';
}

function normalizeWaitMode(value: unknown): 'foreground' | 'background' {
  return value === 'background' ? 'background' : 'foreground';
}

function normalizeActor(value: unknown): ShellActor {
  return value === 'user' || value === 'system' ? value : 'agent';
}

function scopedSession(sessions: ShellSessionRow[]): ShellSessionRow | null {
  return sessions.find((s) => s.name === 'Default' && s.status !== 'closed' && s.status !== 'orphaned')
    ?? sessions.find((s) => s.status !== 'closed' && s.status !== 'orphaned') ?? null;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandWithCwd(command: string, workspaceRoot: string, cwd: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(cwd);
  if (target === root) return command;
  return `cd ${shQuote(target)} && ${command}`;
}

function commandWithCwdCapture(command: string, cwdFile: string): string {
  return [
    command,
    '__codex_shell_status=$?',
    'set +e',
    `pwd > ${shQuote(cwdFile)}`,
    'exit "$__codex_shell_status"',
  ].join('\n');
}

async function readCapturedCwd(workspaceRoot: string, cwdFile: string): Promise<string | null> {
  try {
    const cwd = (await readFile(cwdFile, 'utf8')).trim();
    if (!cwd) return null;
    const resolved = resolve(cwd);
    return isWithin(workspaceRoot, resolved) ? resolved : null;
  } catch {
    return null;
  } finally {
    await unlink(cwdFile).catch(() => {});
  }
}

function tailText(logs: Awaited<ReturnType<typeof store.getShellCommandLogs>>, limit = LOG_TAIL_LIMIT): string {
  const text = logs.map((row) => row.chunk).join('');
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function settingsSnapshot(settings: ToolSettings): Record<string, unknown> {
  return {
    sandbox: settings.sandbox,
    sandboxBackend: settings.sandboxBackend,
    shellUseHostPath: settings.shellUseHostPath,
    shellPathMode: settings.shellPathMode,
    shellPath: settings.shellPath,
    shellAllowCommands: settings.shellAllowCommands,
    network: settings.network,
  };
}

function restoredSettings(session: ShellSessionRow, current: ToolSettings): ToolSettings {
  const snap = session.config_snapshot ?? {};
  return {
    ...current,
    workspaceRoot: session.workspace_root,
    sandbox: snap.sandbox === 'off' || snap.sandbox === 'enforce' ? snap.sandbox : current.sandbox,
    sandboxBackend:
      snap.sandboxBackend === 'auto' || snap.sandboxBackend === 'none' || snap.sandboxBackend === 'bwrap'
        ? snap.sandboxBackend
        : current.sandboxBackend,
    shellUseHostPath: typeof snap.shellUseHostPath === 'boolean' ? snap.shellUseHostPath : current.shellUseHostPath,
    shellPathMode: snap.shellPathMode === 'system' || snap.shellPathMode === 'custom' ? snap.shellPathMode : current.shellPathMode,
    shellPath: typeof snap.shellPath === 'string' ? snap.shellPath : current.shellPath,
    shellAllowCommands: Array.isArray(snap.shellAllowCommands) ? snap.shellAllowCommands.map(String) : current.shellAllowCommands,
    network: snap.network === 'enabled' || snap.network === 'disabled' ? snap.network : current.network,
  };
}

function fallbackName(owner: ShellSessionRow['owner'], index: number): string {
  if (owner === 'system') return 'Default';
  return `${owner === 'user' ? 'User' : 'Agent'} ${index}`;
}

export class ShellManager {
  private active = new Map<string, ActiveCommand>();

  async openSession(input: {
    scope: Scope;
    threadId: string;
    settings: ToolSettings;
    runId?: string;
    name?: string;
    owner?: ShellSessionRow['owner'];
    step?: number;
  }): Promise<ShellSessionRow> {
    const owner = input.owner ?? 'agent';
    const name = await this.nextSessionName(input.scope, input.threadId, input.settings.workspaceRoot, owner, input.name);
    const session = await store.createShellSession(input.scope, {
      threadId: input.threadId,
      name,
      owner,
      workspaceRoot: input.settings.workspaceRoot,
      backend: input.settings.sandboxBackend,
      configSnapshot: settingsSnapshot(input.settings),
    });
    await store.addShellSessionEvent(input.scope, session.id, 'system', 'opened', { runId: input.runId ?? null });
    if (input.runId) {
      await this.emit(input.scope, input.threadId, input.runId, null, {
        type: 'shell_session_opened',
        step: input.step ?? 0,
        sessionId: session.id,
        backend: session.backend,
        workspaceRoot: session.workspace_root,
      });
    } else {
      shellBus.publish(input.threadId, {
        type: 'shell_session_opened',
        step: input.step ?? 0,
        sessionId: session.id,
        backend: session.backend,
        workspaceRoot: session.workspace_root,
      });
    }
    return session;
  }

  async ensureDefaultSession(scope: Scope, threadId: string, settings: ToolSettings): Promise<ShellSessionRow> {
    const existing = (await store.listShellSessions(scope, threadId, settings.workspaceRoot)).find((session) => session.name === 'Default');
    return existing ?? this.openSession({ scope, threadId, settings, owner: 'system', name: 'Default' });
  }

  async reuseSession(input: { scope: Scope; threadId: string; settings: ToolSettings; sessionId?: string; runId?: string; step?: number }): Promise<ShellSessionRow> {
    if (input.sessionId) {
      const session = await store.getShellSession(input.scope, input.sessionId);
      if (!session) throw new Error(`shell session 不存在：${input.sessionId}`);
      if (session.thread_id !== input.threadId) throw new Error('shell session 不属于当前 thread');
      if (session.deleted_at) throw new Error('shell session 已删除');
      if (session.status === 'closed' || session.status === 'orphaned') throw new Error(`shell session 当前状态为 ${session.status}`);
      return session;
    }
    const sessions = await store.listShellSessions(input.scope, input.threadId, input.settings.workspaceRoot);
    const existing = scopedSession(sessions);
    return existing ?? this.ensureDefaultSession(input.scope, input.threadId, input.settings);
  }

  async listSessions(scope: Scope, threadId: string, settings: ToolSettings): Promise<ShellSessionRow[]> {
    await this.ensureDefaultSession(scope, threadId, settings);
    return store.listShellSessions(scope, threadId, settings.workspaceRoot);
  }

  async exec(input: {
    scope: Scope;
    sessionId: string;
    command: string;
    settings: ToolSettings;
    context: ShellToolContext;
    waitMode?: 'foreground' | 'background';
    waitTimeoutMs?: number;
    softTimeoutMs?: number | null;
    hardTimeoutMs?: number | null;
    cwd?: string;
    actor?: ShellActor;
    env?: Record<string, string>;
  }): Promise<{ command: ShellCommandRow; timedOutWaiting: boolean; tail: string }> {
    const commandText = input.command.trim();
    if (!commandText) throw new Error('command 不能为空');
    const session = await store.getShellSession(input.scope, input.sessionId);
    if (!session) throw new Error(`shell session 不存在：${input.sessionId}`);
    if (session.thread_id !== input.context.threadId) throw new Error('shell session 不属于当前 thread');
    if (session.deleted_at) throw new Error('shell session 已删除');
    const recent = await store.listShellCommandsBySession(input.scope, session.id, 10);
    const running = recent.find((cmd) => cmd.status === 'queued' || cmd.status === 'running');
    if (running) throw new Error(`shell session 正在执行命令 ${running.id}，请先 poll 或 kill；需要并发时请打开新的 session。`);

    const waitMode = input.waitMode ?? 'foreground';
    const softTimeoutMs = input.softTimeoutMs ?? DEFAULT_SOFT_TIMEOUT_MS;
    const hardTimeoutMs = input.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
    const cwd = resolve(input.cwd || session.cwd || session.workspace_root);
    if (!isWithin(session.workspace_root, cwd)) throw new Error(`cwd 超出 workspace：${cwd}`);
    if (session.cwd !== cwd) await store.updateShellSession(input.scope, session.id, { cwd });
    const command = await store.createShellCommand(input.scope, {
      sessionId: session.id,
      runId: input.context.runId ?? null,
      stepId: input.context.stepId ?? null,
      actor: input.actor ?? 'agent',
      command: commandText,
      cwd,
      waitMode,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutAt: futureIso(softTimeoutMs),
      hardTimeoutAt: futureIso(hardTimeoutMs),
    });
    const cwdFile = resolve(session.workspace_root, `.codex-shell-cwd-${command.id}`);

    await store.updateShellSession(input.scope, session.id, { status: 'busy', lease_actor: input.actor ?? 'agent', lease_run_id: input.context.runId ?? null });
    await store.addShellSessionEvent(input.scope, session.id, input.actor ?? 'agent', 'command_started', { commandId: command.id, command: commandText });

    const active = await this.spawnCommand({
      scope: input.scope,
      command,
      session,
      cwdFile,
      commandText: commandWithCwd(commandWithCwdCapture(commandText, cwdFile), session.workspace_root, cwd),
      displayCommand: commandText,
      settings: restoredSettings(session, input.settings),
      env: input.env,
      context: input.context,
    });
    if (waitMode === 'background') {
      return { command: await store.getShellCommand(input.scope, command.id) ?? command, timedOutWaiting: false, tail: '' };
    }

    const waitMs = input.waitTimeoutMs ?? DEFAULT_WAIT_MS;
    const completed = await Promise.race([active.done, sleep(waitMs)]);
    if (completed === 'timeout') {
      const logs = await store.getShellCommandLogs(input.scope, command.id, 0, 50);
      return {
        command: await store.getShellCommand(input.scope, command.id) ?? command,
        timedOutWaiting: true,
        tail: redactShellOutput(tailText(logs)),
      };
    }
    const logs = await store.getShellCommandLogs(input.scope, command.id, 0, 200);
    return { command: completed, timedOutWaiting: false, tail: redactShellOutput(tailText(logs, 4000)) };
  }

  async poll(scope: Scope, id: string, sinceSeq = 0): Promise<{ session?: ShellSessionRow; command?: ShellCommandRow; logs: Awaited<ReturnType<typeof store.getShellCommandLogs>> }> {
    const command = await store.getShellCommand(scope, id);
    if (command) {
      return { command, logs: await store.getShellCommandLogs(scope, id, sinceSeq, 200) };
    }
    const session = await store.getShellSession(scope, id);
    if (!session) throw new Error(`shell session/command 不存在：${id}`);
    const commands = await store.listShellCommandsBySession(scope, session.id, 1);
    const latest = commands[0];
    return { session, command: latest, logs: latest ? await store.getShellCommandLogs(scope, latest.id, sinceSeq, 200) : [] };
  }

  async kill(scope: Scope, commandId: string, reason = 'user_requested_kill', signal: NodeJS.Signals = 'SIGTERM'): Promise<ShellCommandRow> {
    const command = await store.getShellCommand(scope, commandId);
    if (!command) throw new Error(`shell command 不存在：${commandId}`);
    const active = this.active.get(commandId);
    if (!active) {
      if (!commandDone(command.status)) {
        await store.updateShellCommand(scope, commandId, { status: 'killed', signal, attention: reason, ended_at: nowIso() });
        await store.updateShellSession(scope, command.session_id, { status: 'idle', lease_actor: null, lease_run_id: null });
      }
      return (await store.getShellCommand(scope, commandId)) ?? command;
    }
    await store.updateShellCommand(scope, commandId, { attention: reason, signal });
    await this.emitCommandEvent(active, { type: 'shell_command_killed', step: active.step, sessionId: active.sessionId, commandId, signal, reason });
    active.killRequested = true;
    this.killProcess(active, signal);
    setTimeout(() => {
      if (this.active.has(commandId)) this.killProcess(active, 'SIGKILL');
    }, KILL_GRACE_MS).unref();
    const completed = await Promise.race([active.done, sleep(1_000)]);
    if (completed !== 'timeout') return completed;
    return (await store.getShellCommand(scope, commandId)) ?? command;
  }

  async killRunCommands(scope: Scope, runId: string, reason = 'run_cancel'): Promise<void> {
    for (const command of await store.listRunningShellCommandsByRun(scope, runId)) {
      await this.kill(scope, command.id, reason);
    }
  }

  async markInterruptedCommandsOrphaned(): Promise<number> {
    const running = await store.listRunningShellCommandsUnscoped();
    for (const command of running) {
      await store.updateShellCommandUnscoped(command.id, {
        status: 'orphaned',
        attention: 'server_restarted',
        error: '服务重启后无法重新连接本地 shell 进程。',
        ended_at: nowIso(),
      });
      await store.updateShellSessionUnscoped(command.session_id, { status: 'idle', lease_actor: null, lease_run_id: null });
    }
    return running.length;
  }

  private async nextSessionName(scope: Scope, threadId: string, workspaceRoot: string, owner: ShellSessionRow['owner'], requested?: string): Promise<string> {
    const sessions = await store.listShellSessions(scope, threadId, workspaceRoot);
    const used = new Set(sessions.map((session) => session.name));
    const trimmed = requested?.trim();
    if (owner === 'system') return 'Default';
    if (trimmed && trimmed !== 'Default' && !used.has(trimmed)) return trimmed;
    for (let index = 1; ; index += 1) {
      const name = fallbackName(owner, index);
      if (!used.has(name)) return name;
    }
  }

  private async spawnCommand(input: {
    scope: Scope;
    command: ShellCommandRow;
    session: ShellSessionRow;
    cwdFile: string;
    commandText: string;
    displayCommand: string;
    settings: ToolSettings;
    env?: Record<string, string>;
    context: ShellToolContext;
  }): Promise<ActiveCommand> {
    const shellCfg = {
      policyMode: input.settings.sandbox,
      backend: input.settings.sandboxBackend,
      workspaceRoot: input.session.workspace_root,
      allowCommands: input.settings.shellAllowCommands,
      useHostPath: input.settings.shellUseHostPath,
      envPath: shellPathForSettings(input.settings),
      shareNet: input.settings.network === 'enabled',
      env: input.env,
    };
    const spec = buildShellSpawnSpec(input.commandText, shellCfg);
    await store.updateShellCommand(input.scope, input.command.id, { status: 'running' });
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const active: ActiveCommand = {
      ...deferredCommand(),
      process: child,
      scope: input.scope,
      threadId: input.session.thread_id,
      sessionId: input.session.id,
      commandId: input.command.id,
      workspaceRoot: input.session.workspace_root,
      cwdFile: input.cwdFile,
      runId: input.context.runId,
      stepId: input.context.stepId,
      step: input.context.step ?? 0,
      startedAt: Date.now(),
      outputBytes: 0,
      cleanupPaths: spec.cleanupPaths ?? [],
      writeChain: Promise.resolve(),
    };
    this.active.set(input.command.id, active);

    void store.updateShellCommand(input.scope, input.command.id, { host_pid: child.pid ?? null }).catch((err) => {
      console.warn(`shell host pid update failed for ${input.command.id}: ${(err as Error).message}`);
    });
    child.stdout?.on('data', (chunk) => this.enqueueOutput(active, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => this.enqueueOutput(active, 'stderr', chunk));
    child.on('error', (err) => void this.finishCommand(active, 'failed', null, null, err.message));
    child.on('exit', (code, signal) => void this.finishCommand(active, code === 0 ? 'succeeded' : 'failed', code, signal ?? null));
    child.on('close', (code, signal) => void this.finishCommand(active, code === 0 ? 'succeeded' : 'failed', code, signal ?? null));

    await this.emitCommandEvent(active, {
      type: 'shell_command_started',
      step: active.step,
      sessionId: input.session.id,
      commandId: input.command.id,
      command: input.displayCommand,
      waitMode: input.command.wait_mode,
      startedAt: input.command.started_at,
    });

    if (input.command.soft_timeout_ms != null) {
      active.softTimer = setTimeout(() => void this.softTimeout(active), input.command.soft_timeout_ms);
      active.softTimer.unref();
    }
    if (input.command.hard_timeout_ms != null) {
      active.hardTimer = setTimeout(() => void this.hardTimeout(active), input.command.hard_timeout_ms);
      active.hardTimer.unref();
    }

    return active;
  }

  private enqueueOutput(active: ActiveCommand, stream: ShellLogStream, raw: Buffer | string): void {
    // stdout/stderr 事件可能交错到达；串行写库可以稳定 seq，并避免 max(seq)+1 并发冲突。
    active.writeChain = active.writeChain
      .then(() => this.recordOutput(active, stream, raw))
      .catch((err) => {
        console.warn(`shell output write failed for ${active.commandId}: ${(err as Error).message}`);
      });
  }

  private async recordOutput(active: ActiveCommand, stream: ShellLogStream, raw: Buffer | string): Promise<void> {
    const text = redactShellOutput(String(raw)).replace(/\u0000/g, '');
    if (!text) return;
    active.outputBytes += Buffer.byteLength(text);
    const log = await store.appendShellCommandLog(active.scope, active.commandId, stream, text);
    await store.updateShellCommand(active.scope, active.commandId, { output_bytes: active.outputBytes, last_output_at: nowIso() });
    await this.emitCommandEvent(active, {
      type: 'shell_command_output',
      step: active.step,
      sessionId: active.sessionId,
      commandId: active.commandId,
      stream,
      seq: log.seq,
      text,
    });
  }

  private async softTimeout(active: ActiveCommand): Promise<void> {
    if (!this.active.has(active.commandId)) return;
    const runtimeMs = Date.now() - active.startedAt;
    await store.updateShellCommand(active.scope, active.commandId, { attention: 'soft_timeout' });
    await this.emitCommandEvent(active, {
      type: 'shell_command_timeout',
      step: active.step,
      sessionId: active.sessionId,
      commandId: active.commandId,
      soft: true,
      runtimeMs,
      message: 'shell command 已超过软超时，仍在后台运行。',
    });
  }

  private async hardTimeout(active: ActiveCommand): Promise<void> {
    if (!this.active.has(active.commandId)) return;
    await store.updateShellCommand(active.scope, active.commandId, { attention: 'hard_timeout' });
    await this.emitCommandEvent(active, {
      type: 'shell_command_timeout',
      step: active.step,
      sessionId: active.sessionId,
      commandId: active.commandId,
      soft: false,
      runtimeMs: Date.now() - active.startedAt,
      message: 'shell command 已超过硬超时，正在终止。',
    });
    this.killProcess(active, 'SIGTERM');
    setTimeout(() => {
      if (this.active.has(active.commandId)) this.killProcess(active, 'SIGKILL');
    }, KILL_GRACE_MS).unref();
  }

  private async finishCommand(
    active: ActiveCommand,
    status: 'succeeded' | 'failed' | 'killed' | 'timed_out',
    code: number | null,
    signal: string | null,
    error?: string,
  ): Promise<void> {
    if (!this.active.has(active.commandId)) return;
    if (active.finishStarted) return;
    active.finishStarted = true;
    if (active.softTimer) clearTimeout(active.softTimer);
    if (active.hardTimer) clearTimeout(active.hardTimer);
    // exit 可能早于最后一段 stdout/stderr data，到这里稍等一拍再收尾。
    await sleep(25);
    await active.writeChain;
    this.active.delete(active.commandId);
    await Promise.all(active.cleanupPaths.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));

    const rowBefore = await store.getShellCommand(active.scope, active.commandId);
    const finalStatus = rowBefore?.attention === 'hard_timeout' ? 'timed_out' : active.killRequested ? 'killed' : status;
    await store.updateShellCommand(active.scope, active.commandId, {
      status: finalStatus,
      exit_code: code,
      signal,
      error: error ?? null,
      ended_at: nowIso(),
    });
    const finalCwd = await readCapturedCwd(active.workspaceRoot, active.cwdFile);
    const session = await store.getShellSession(active.scope, active.sessionId);
    const terminalSession = !!session?.deleted_at || session?.status === 'closed' || session?.status === 'closing' || session?.status === 'orphaned';
    await store.updateShellSession(active.scope, active.sessionId, {
      // 关闭/孤儿化是 session 的终态；迟到的进程退出事件不能把它改回 idle。
      ...(terminalSession ? {} : { status: 'idle' }),
      lease_actor: null,
      lease_run_id: null,
      ...(finalCwd ? { cwd: finalCwd } : {}),
    });
    const row = (await store.getShellCommand(active.scope, active.commandId)) ?? rowBefore;
    await this.emitCommandEvent(active, {
      type: 'shell_command_finished',
      step: active.step,
      sessionId: active.sessionId,
      commandId: active.commandId,
      status: finalStatus,
      exitCode: code,
      signal,
      durationMs: Date.now() - active.startedAt,
    });
    if (row) active.resolveDone(row);
  }

  private killProcess(active: ActiveCommand, signal: NodeJS.Signals): void {
    const pid = active.process.pid;
    if (!pid) return;
    try {
      if (process.platform === 'win32') active.process.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      try {
        active.process.kill(signal);
      } catch {
        /* 进程可能已经退出。 */
      }
    }
  }

  private async emitCommandEvent(active: ActiveCommand, event: AgentEvent): Promise<void> {
    await this.emit(active.scope, active.threadId, active.runId, active.stepId ?? null, event);
  }

  private async emit(scope: Scope, threadId: string, runId: string | undefined, stepId: string | null, event: AgentEvent): Promise<void> {
    shellBus.publish(threadId, event);
    if (runId) {
      await store.addEvent(scope, runId, stepId, event);
      runBus.publish(runId, event);
    }
  }
}

export const shellManager = new ShellManager();

export function parseWaitMode(value: unknown): 'foreground' | 'background' {
  return normalizeWaitMode(value);
}

export function parseShellActor(value: unknown): ShellActor {
  return normalizeActor(value);
}

export function formatCommandResult(input: { command: ShellCommandRow; timedOutWaiting?: boolean; tail?: string; logs?: Awaited<ReturnType<typeof store.getShellCommandLogs>> }): string {
  const command = input.command;
  const logsTail = input.tail ?? (input.logs ? tailText(input.logs, 4000) : '');
  const tail = redactShellOutput(logsTail.trim());
  if (input.timedOutWaiting) {
    return [
      `shell command 仍在运行：${command.id}`,
      `session: ${command.session_id}`,
      `status: ${command.status}`,
      `后续使用 shell_poll(commandId="${command.id}") 查看进度，或 shell_kill(commandId="${command.id}") 终止。`,
      tail ? `最近输出：\n${tail}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    `shell command: ${command.id}`,
    `session: ${command.session_id}`,
    `status: ${command.status}`,
    command.exit_code != null ? `exit_code: ${command.exit_code}` : '',
    command.signal ? `signal: ${command.signal}` : '',
    tail ? `输出：\n${tail}` : '（无输出）',
  ].filter(Boolean).join('\n');
}
