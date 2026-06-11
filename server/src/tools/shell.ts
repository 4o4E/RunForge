import { getToolSettings } from '../settings.js';
import { runShellCommand } from './sandbox.js';
import type { Tool } from './types.js';

const isWindows = process.platform === 'win32';

export const shellTool: Tool = {
  name: 'shell',
  description: isWindows
    ? 'Execute a PowerShell command on the host (Windows) and return stdout/stderr. / 在宿主 Windows 上执行 PowerShell 命令并返回 stdout/stderr。'
    : 'Execute a shell command (/bin/sh) and return stdout/stderr. In sandbox mode, cwd and HOME are the configured persistent workspace; /tmp is per-command temporary storage, so clone or create project files under the workspace, not /tmp. / 执行 shell 命令并返回 stdout/stderr。沙箱模式下 cwd 和 HOME 是配置的持久工作区；/tmp 是每次命令单独的临时目录，所以 clone 或创建项目文件要放在工作区内，不要放到 /tmp。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The command to execute. Use workspace paths for persistent files. / 要执行的命令。需要持久保留的文件请使用工作区路径。',
      },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000). / 超时时间，单位毫秒（默认 60000）。' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command ?? '');
    const timeout = Number(args.timeout_ms ?? 60000);
    const settings = ctx?.settings ?? (await getToolSettings());
    try {
      const { stdout, stderr } = await runShellCommand(command, timeout, {
        policyMode: settings.sandbox,
        backend: settings.sandboxBackend,
        workspaceRoot: settings.workspaceRoot,
        allowCommands: settings.shellAllowCommands,
        shareNet: settings.network === 'enabled',
      });
      return [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n').trim() || '(no output)';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `Command failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    }
  },
};
