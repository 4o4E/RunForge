import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from './types.js';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

/**
 * Run a shell command. On Windows this uses PowerShell; elsewhere /bin/sh.
 */
function spawnShell(command: string, timeout: number) {
  if (isWindows) {
    return execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout, maxBuffer: 1024 * 1024 * 10, windowsHide: true },
    );
  }
  return execFileAsync('/bin/sh', ['-c', command], { timeout, maxBuffer: 1024 * 1024 * 10 });
}

export const shellTool: Tool = {
  name: 'shell',
  description: isWindows
    ? 'Execute a PowerShell command on the host (Windows) and return its stdout/stderr.'
    : 'Execute a shell command (/bin/sh) on the host and return its stdout/stderr.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute (PowerShell on Windows, sh elsewhere)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000)' },
    },
    required: ['command'],
  },
  async run(args) {
    const command = String(args.command ?? '');
    const timeout = Number(args.timeout_ms ?? 60000);
    try {
      const { stdout, stderr } = await spawnShell(command, timeout);
      return [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n').trim() || '(no output)';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `Command failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    }
  },
};
