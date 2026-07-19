import type { Tool, ToolRunContext } from './types.js';
import { formatCommandResult, parseShellActor, parseWaitMode, shellManager } from '../shell/manager.js';
import { shellBus } from '../shell/bus.js';
import { store } from '../store/index.js';
import type { Scope } from '../store/types.js';
import { requiresDatabaseAccess, usesDatabaseAccessHelper, usesDatabaseCli } from './databaseAccessGuard.js';

function requireShellContext(ctx: ToolRunContext | undefined): { scope: Scope; threadId: string; runId?: string; stepId?: string; step?: number } {
  if (!ctx?.scope) throw new Error('托管 shell 需要当前身份 scope，上下文缺失。');
  if (!ctx?.threadId) throw new Error('托管 shell 需要当前 threadId，上下文缺失。');
  return { scope: ctx.scope, threadId: ctx.threadId, runId: ctx.runId, stepId: ctx.stepId, step: ctx.step };
}

function numberArg(value: unknown, fallback: number | null = null): number | null {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const shellSessionOpenTool: Tool = {
  name: 'shell_session_open',
  description: '创建一个托管 shell session。shell 会保留名称、cwd 和命令历史；真实进程按命令启动，结束后自动释放。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '给用户看的 shell 名称；不填时自动生成 Agent 1、Agent 2 等名称。Default 由系统保留。' },
    },
  },
  async run(args, ctx) {
    const settings = ctx?.settings;
    if (!settings) throw new Error('缺少工具配置');
    const shellCtx = requireShellContext(ctx);
    const session = await shellManager.openSession({
      scope: shellCtx.scope,
      threadId: shellCtx.threadId,
      settings,
      runId: shellCtx.runId,
      owner: 'agent',
      name: typeof args.name === 'string' ? args.name : undefined,
      step: shellCtx.step,
    });
    return `已创建 shell：${session.name}\nid: ${session.id}\nworkspace: ${session.workspace_root}\nbackend: ${session.backend}`;
  },
};

export const shellSessionReuseTool: Tool = {
  name: 'shell_session_reuse',
  description: '复用当前 thread/workspace 下已有的托管 shell session；没有可用 session 时会创建一个。',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: '指定要复用的 session id；不填则自动选择当前 thread 下可用 session。' },
    },
  },
  async run(args, ctx) {
    const settings = ctx?.settings;
    if (!settings) throw new Error('缺少工具配置');
    const shellCtx = requireShellContext(ctx);
    const session = await shellManager.reuseSession({
      scope: shellCtx.scope,
      threadId: shellCtx.threadId,
      settings,
      runId: shellCtx.runId,
      step: shellCtx.step,
      sessionId: typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : undefined,
    });
    return `可用 shell：${session.name}\nid: ${session.id}\nstatus: ${session.status}\nworkspace: ${session.workspace_root}\nbackend: ${session.backend}`;
  },
};

export const shellSessionListTool: Tool = {
  name: 'shell_session_list',
  description: '列出当前 thread/workspace 下的托管 shell session 和最近命令。',
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const settings = ctx?.settings;
    if (!settings) throw new Error('缺少工具配置');
    const shellCtx = requireShellContext(ctx);
    const sessions = await shellManager.listSessions(shellCtx.scope, shellCtx.threadId, settings);
    if (!sessions.length) return '当前 thread 没有可用 shell session。';
    const lines: string[] = [];
    for (const session of sessions) {
      const commands = await store.listShellCommandsBySession(shellCtx.scope, session.id, 3);
      lines.push(`- ${session.name} (${session.id}) owner=${session.owner} status=${session.status}`);
      for (const cmd of commands) lines.push(`  - ${cmd.id} ${cmd.status} ${cmd.command.slice(0, 120)}`);
    }
    return lines.join('\n');
  },
};

export const shellExecTool: Tool = {
  name: 'shell_exec',
  description:
    '在托管 shell session 中执行命令。wait=foreground 时等待完成或等待超时；wait=background 时立即返回 commandId，后续用 shell_poll 查看进度。',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'shell session id。可先调用 shell_session_reuse 获取。' },
      command: { type: 'string', description: '要执行的 shell 命令。' },
      wait: { type: 'string', enum: ['foreground', 'background'], description: 'foreground=等待完成；background=后台运行。' },
      timeout_ms: { type: 'number', description: 'foreground 最多等待多久；超时后命令继续后台运行。默认 60000。' },
      soft_timeout_ms: { type: 'number', description: '软超时；到点提示但不终止。默认 10 分钟。' },
      hard_timeout_ms: { type: 'number', description: '硬超时；到点终止。默认 30 分钟。' },
    },
    required: ['sessionId', 'command'],
  },
  async run(args, ctx) {
    const settings = ctx?.settings;
    if (!settings) throw new Error('缺少工具配置');
    const command = String(args.command ?? '');
    if (requiresDatabaseAccess(command) && !ctx?.env?.DB_WORKLOAD_TOKEN) {
      return '数据库 CLI 或 database-access SDK 脚本需要先激活 database-access skill，由本次 run 的 workload token 换取短期凭证；不要跨 run 复用旧凭证。';
    }
    if (usesDatabaseCli(command) && !usesDatabaseAccessHelper(command)) {
      return '检测到直接调用数据库 CLI。DB_WORKLOAD_TOKEN 只是本次 run 换取短期凭证的令牌，不是数据库密码；请使用 database-access helper（例如 psql_query.py 或 db_credential.py/db_credential.sh）在同一命令内换取本 run 的短期凭证，不要复用旧 run 的数据库用户名或宿主 DATABASE_URL。';
    }
    const shellCtx = requireShellContext(ctx);
    const result = await shellManager.exec({
      scope: shellCtx.scope,
      sessionId: String(args.sessionId ?? '').trim(),
      command,
      settings,
      context: shellCtx,
      waitMode: parseWaitMode(args.wait),
      waitTimeoutMs: numberArg(args.timeout_ms, null) ?? undefined,
      softTimeoutMs: numberArg(args.soft_timeout_ms, null),
      hardTimeoutMs: numberArg(args.hard_timeout_ms, null),
      actor: parseShellActor(args.actor),
      env: ctx?.env,
    });
    return formatCommandResult(result);
  },
};

export const shellPollTool: Tool = {
  name: 'shell_poll',
  description: '查看 shell session 或 command 的最新状态和增量输出。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'shell session id 或 shell command id。' },
      sinceSeq: { type: 'number', description: '只返回大于该 seq 的日志。' },
    },
    required: ['id'],
  },
  async run(args, ctx) {
    if (!ctx?.scope) throw new Error('托管 shell 需要当前身份 scope，上下文缺失。');
    const id = String(args.id ?? '').trim();
    const sinceSeq = numberArg(args.sinceSeq, 0) ?? 0;
    const result = await shellManager.poll(ctx.scope, id, sinceSeq);
    if (!result.command) {
      return `shell session: ${result.session?.id}\nstatus: ${result.session?.status}\n暂无命令。`;
    }
    return formatCommandResult({ command: result.command, logs: result.logs });
  },
};

export const shellKillTool: Tool = {
  name: 'shell_kill',
  description: '终止正在运行的 shell command。默认先 SIGTERM，未退出再由后端升级 SIGKILL。',
  parameters: {
    type: 'object',
    properties: {
      commandId: { type: 'string', description: '要终止的 shell command id。' },
      reason: { type: 'string', description: '终止原因。' },
    },
    required: ['commandId'],
  },
  async run(args, ctx) {
    if (!ctx?.scope) throw new Error('托管 shell 需要当前身份 scope，上下文缺失。');
    const command = await shellManager.kill(ctx.scope, String(args.commandId ?? '').trim(), String(args.reason ?? 'agent_requested_kill'));
    return `已请求终止 shell command：${command.id}\nstatus: ${command.status}`;
  },
};

export const shellSessionCloseTool: Tool = {
  name: 'shell_session_close',
  description: '删除 agent 创建的托管 shell（软删除，历史命令保留）。Default 和用户创建的 shell 不能由 LLM 删除。',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'shell session id。' },
    },
    required: ['sessionId'],
  },
  async run(args, ctx) {
    const shellCtx = requireShellContext(ctx);
    const sessionId = String(args.sessionId ?? '').trim();
    const session = await store.getShellSession(shellCtx.scope, sessionId);
    if (!session) throw new Error(`shell session 不存在：${sessionId}`);
    if (session.thread_id !== shellCtx.threadId) throw new Error('shell session 不属于当前 thread');
    if (session.name === 'Default' || session.owner === 'system') return 'Default shell 不支持删除。';
    if (session.owner !== 'agent') return '只能删除 agent 创建的 shell，不能删除用户创建的 shell。';
    const commands = await store.listShellCommandsBySession(shellCtx.scope, sessionId, 20);
    const running = commands.filter((cmd) => cmd.status === 'running' || cmd.status === 'queued');
    if (running.length) return `shell session 仍有运行中命令，请先 shell_kill：${running.map((cmd) => cmd.id).join(', ')}`;
    await store.updateShellSession(shellCtx.scope, sessionId, { status: 'closed', lease_actor: null, lease_run_id: null, deleted_at: new Date().toISOString() });
    await store.addShellSessionEvent(shellCtx.scope, sessionId, 'agent', 'deleted', { runId: shellCtx.runId ?? null });
    shellBus.publish(shellCtx.threadId, { type: 'shell_session_closed', step: shellCtx.step ?? 0, sessionId });
    return `已删除 shell：${session.name} (${sessionId})`;
  },
};

export const managedShellTools: Tool[] = [
  shellSessionOpenTool,
  shellSessionReuseTool,
  shellSessionListTool,
  shellExecTool,
  shellPollTool,
  shellKillTool,
  shellSessionCloseTool,
];
