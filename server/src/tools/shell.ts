import { getToolSettings, shellPathForSettings } from '../settings.js';
import { formatCommandResult, shellManager } from '../shell/manager.js';
import { redactShellOutput } from '../shell/redact.js';
import { runShellCommand } from './sandbox.js';
import type { Tool } from './types.js';
import { requiresDatabaseAccess, usesDatabaseAccessHelper, usesDatabaseCli } from './databaseAccessGuard.js';

const isWindows = process.platform === 'win32';

export const shellTool: Tool = {
  name: 'shell',
  description: isWindows
    ? '在宿主 Windows 上执行 PowerShell 命令并返回 stdout/stderr。'
    : '执行 shell 命令并返回 stdout/stderr。cwd 和 HOME 是配置的持久工作区；只继承宿主 PATH，不继承后端 DATABASE_URL 或 API key；Python 依赖必须安装到虚拟环境，优先使用 uv 创建 .venv，不要全局安装依赖。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的命令。需要持久保留的文件请使用工作区路径。',
      },
      timeout_ms: { type: 'number', description: '超时时间，单位毫秒（默认 60000）。' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command ?? '');
    const timeout = Number(args.timeout_ms ?? 60000);
    if (!ctx?.scope) throw new Error('shell 需要当前身份 scope，上下文缺失。');
    const settings = ctx?.settings ?? (await getToolSettings(ctx.scope));
    if (requiresDatabaseAccess(command) && !ctx?.env?.DB_WORKLOAD_TOKEN) {
      return '数据库 CLI 需要先激活 database-access skill，由本次 run 的 workload token 换取短期凭证；不要使用宿主 DATABASE_URL 或本机默认数据库账号直连。';
    }
    if (usesDatabaseCli(command) && !usesDatabaseAccessHelper(command)) {
      return '检测到直接调用数据库 CLI。DB_WORKLOAD_TOKEN 只是本次 run 换取短期凭证的令牌，不是数据库密码；请使用 database-access helper（例如 psql_query.py 或 db_credential.py/db_credential.sh）在同一命令内换取本 run 的短期凭证，不要复用旧 run 的数据库用户名或宿主 DATABASE_URL。';
    }
    try {
      if (ctx?.threadId && ctx.settings) {
        const session = await shellManager.reuseSession({
          scope: ctx.scope,
          threadId: ctx.threadId,
          settings,
          runId: ctx.runId,
          step: ctx.step,
        });
        const result = await shellManager.exec({
          scope: ctx.scope,
          sessionId: session.id,
          command,
          settings,
          context: { threadId: ctx.threadId, runId: ctx.runId, stepId: ctx.stepId, step: ctx.step },
          waitMode: 'foreground',
          waitTimeoutMs: timeout,
          softTimeoutMs: Math.max(timeout, 10 * 60_000),
          hardTimeoutMs: Math.max(timeout * 3, 30 * 60_000),
          env: ctx.env,
        });
        return formatCommandResult(result);
      }
      const { stdout, stderr } = await runShellCommand(command, timeout, {
        policyMode: settings.sandbox,
        backend: settings.sandboxBackend,
        workspaceRoot: settings.workspaceRoot,
        allowCommands: settings.shellAllowCommands,
        useHostPath: settings.shellUseHostPath,
        envPath: shellPathForSettings(settings),
        shareNet: settings.network === 'enabled',
        env: ctx?.env,
      });
      const output = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n').trim();
      return output ? redactShellOutput(output) : '（无输出）';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return redactShellOutput(`命令执行失败：${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim());
    }
  },
};
