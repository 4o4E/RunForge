import { getToolSettings } from '../settings.js';
import { runShellCommand } from './sandbox.js';
import type { Tool } from './types.js';

const isWindows = process.platform === 'win32';
const SECRET_OUTPUT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/"(password|passwd|token|secret|credential|connectionUrl)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"'],
  [/\b([A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY|DATABASE_URL|CONNECTION_URL)[A-Z0-9_]*)=('[^']*'|"[^"]*"|[^\s;&|]+)/gi, '$1=[redacted]'],
  [/\b([A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY)[A-Z0-9_]*)=('[^']*'|"[^"]*"|[^\s;&|]+)/gi, '$1=[redacted]'],
  [/(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, '$1$2:[redacted]@'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'],
];
const DATABASE_CLI_RE = /(^|[\s;&|()])(?:psql|mysql|mongosh|beeline|duckdb|sqlite3)\b|\$DATABASE_URL|\$\{DATABASE_URL[}:+-]?/;

function redactShellOutput(output: string): string {
  return SECRET_OUTPUT_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), output);
}

function requiresDatabaseAccess(command: string): boolean {
  return DATABASE_CLI_RE.test(command);
}

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
    const settings = ctx?.settings ?? (await getToolSettings());
    if (requiresDatabaseAccess(command) && !ctx?.env?.DB_WORKLOAD_TOKEN) {
      return '数据库 CLI 需要先激活 database-access skill，由本次 run 的 workload token 换取短期凭证；不要使用宿主 DATABASE_URL 或本机默认数据库账号直连。';
    }
    try {
      const { stdout, stderr } = await runShellCommand(command, timeout, {
        policyMode: settings.sandbox,
        backend: settings.sandboxBackend,
        workspaceRoot: settings.workspaceRoot,
        allowCommands: settings.shellAllowCommands,
        useHostPath: settings.shellUseHostPath,
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
