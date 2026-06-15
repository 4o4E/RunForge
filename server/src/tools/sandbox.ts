import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxBackendName } from '@my-agent/contracts';
export type { SandboxBackendName } from '@my-agent/contracts';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

export interface ShellSandboxConfig {
  policyMode: 'off' | 'enforce';
  backend: SandboxBackendName;
  workspaceRoot: string;
  allowCommands: string[];
  useHostPath: boolean;
  shareNet: boolean;
  env?: Record<string, string>;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
}

export interface ShellSpawnSpec {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  backend: 'host' | 'bwrap';
}

export interface ResolvedCommand {
  name: string;
  source: string;
  dest: string;
}

interface BwrapOptions {
  workspaceRoot: string;
  command: string;
  allowCommands: string[];
  shareNet: boolean;
  envPath?: string;
  env?: Record<string, string>;
}

const warned = new Set<string>();
const bwrapProbeCache = new Map<string, boolean>();

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canStartBwrap(bwrapPath: string): boolean {
  const cached = bwrapProbeCache.get(bwrapPath);
  if (cached != null) return cached;
  try {
    execFileSync(bwrapPath, ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--', '/bin/true'], {
      stdio: 'ignore',
      timeout: 1000,
    });
    bwrapProbeCache.set(bwrapPath, true);
    return true;
  } catch {
    bwrapProbeCache.set(bwrapPath, false);
    return false;
  }
}

/** 在 PATH 中查找可执行文件;绝对/相对路径会先按路径本身校验。 */
export function findExecutable(name: string, envPath = process.env.PATH ?? ''): string | undefined {
  if (!name) return undefined;
  if (name.includes('/')) {
    const path = isAbsolute(name) ? name : resolve(name);
    return canExecute(path) ? path : undefined;
  }

  for (const dir of envPath.split(delimiter).filter(Boolean)) {
    const candidate = resolve(dir, name);
    if (canExecute(candidate)) return candidate;
  }
  return undefined;
}

/** bwrap 需要提前创建挂载点的父目录,这里只返回从浅到深的目录列表。 */
export function parentDirs(path: string): string[] {
  const dirs: string[] = [];
  let current = dirname(path);
  while (current && current !== '/') {
    dirs.unshift(current);
    current = dirname(current);
  }
  return dirs;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function existing(paths: string[]): string[] {
  return paths.filter((p) => existsSync(p));
}

function safeEnvEntries(env: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(env ?? {}).filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string');
}

/** 把命令白名单解析成源路径和沙箱内目标路径,缺失命令会被跳过。 */
export function resolveAllowedCommands(names: string[], envPath = process.env.PATH ?? ''): ResolvedCommand[] {
  return unique(names)
    .map((name) => {
      const dest = findExecutable(name, envPath);
      if (!dest) return undefined;
      return { name, source: realpathSync(dest), dest };
    })
    .filter((cmd): cmd is ResolvedCommand => Boolean(cmd));
}

/** 生成 bwrap 参数;纯函数便于单测,实际执行由 runShellCommand 完成。 */
export function buildBwrapArgs(opts: BwrapOptions): string[] {
  const workspaceRoot = resolve(opts.workspaceRoot);
  const shell: ResolvedCommand = { name: 'sh', source: realpathSync('/bin/sh'), dest: '/bin/sh' };
  const commands = resolveAllowedCommands(opts.allowCommands, opts.envPath);
  const bindFiles = unique([shell, ...commands].map((cmd) => `${cmd.source}\0${cmd.dest}`)).map((pair) => {
    const [source, dest] = pair.split('\0');
    return { source, dest };
  });
  const libDirs = existing(['/lib', '/lib64', '/usr/lib', '/usr/lib64']);
  const etcFiles = existing(
    opts.shareNet
      ? ['/etc/ld.so.cache', '/etc/hosts', '/etc/resolv.conf', '/etc/nsswitch.conf']
      : ['/etc/ld.so.cache'],
  );
  const extraReadOnlyPaths = existing([
    ...(opts.shareNet ? ['/etc/ssl/certs', '/usr/share/ca-certificates'] : []),
    ...(commands.some((cmd) => cmd.name === 'git') ? ['/usr/share/git-core'] : []),
  ]);
  const pathDirs = unique(commands.map((cmd) => dirname(cmd.dest)));
  const mountDirs = unique([
    ...libDirs.flatMap(parentDirs),
    ...etcFiles.flatMap(parentDirs),
    ...extraReadOnlyPaths.flatMap(parentDirs),
    ...bindFiles.flatMap((file) => parentDirs(file.dest)),
    ...parentDirs(workspaceRoot),
  ]);

  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--tmpfs', '/'];
  if (opts.shareNet) args.push('--share-net');
  args.push('--clearenv');

  for (const dir of mountDirs) args.push('--dir', dir);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const dir of libDirs) args.push('--ro-bind', dir, dir);
  for (const file of etcFiles) args.push('--ro-bind', file, file);
  for (const path of extraReadOnlyPaths) args.push('--ro-bind', path, path);
  for (const file of bindFiles) args.push('--ro-bind', file.source, file.dest);

  args.push('--bind', workspaceRoot, workspaceRoot);
  args.push('--chdir', workspaceRoot);
  args.push('--setenv', 'PATH', pathDirs.length ? pathDirs.join(':') : '/usr/bin:/bin');
  args.push('--setenv', 'HOME', workspaceRoot, '--setenv', 'PWD', workspaceRoot);
  for (const [key, value] of safeEnvEntries(opts.env)) args.push('--setenv', key, value);
  args.push('--', shell.dest, '-c', opts.command);
  return args;
}

function hostShellEnv(workspaceRoot: string, env?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...env,
    HOME: workspaceRoot,
    PWD: workspaceRoot,
  };
}

function hostShell(command: string, timeout: number, workspaceRoot: string, env?: Record<string, string>): Promise<ShellExecResult> {
  const childEnv = hostShellEnv(workspaceRoot, env);
  if (isWindows) {
    return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeout,
      maxBuffer: 1024 * 1024 * 10,
      windowsHide: true,
      cwd: workspaceRoot,
      env: childEnv,
    });
  }
  return execFileAsync('/bin/sh', ['-c', command], { timeout, maxBuffer: 1024 * 1024 * 10, cwd: workspaceRoot, env: childEnv });
}

function shouldUseBwrap(cfg: ShellSandboxConfig): { use: true; bwrapPath: string } | { use: false } {
  if (isWindows || cfg.useHostPath || cfg.policyMode !== 'enforce' || cfg.backend === 'none') return { use: false };
  if (process.platform !== 'linux') {
    if (cfg.backend === 'bwrap') throw new Error('bwrap 沙箱需要 Linux 环境');
    warnOnce('bwrap-non-linux', '工具沙箱 auto 模式：当前不是 Linux，shell 回落到宿主执行。');
    return { use: false };
  }

  const bwrapPath = findExecutable('bwrap');
  if (!bwrapPath) {
    if (cfg.backend === 'bwrap') throw new Error('TOOL_SANDBOX_BACKEND=bwrap，但 PATH 中找不到 bwrap');
    warnOnce('bwrap-missing', '工具沙箱 auto 模式：找不到 bwrap，shell 回落到宿主执行。');
    return { use: false };
  }
  if (canStartBwrap(bwrapPath)) return { use: true, bwrapPath };
  if (cfg.backend === 'bwrap') {
    throw new Error('TOOL_SANDBOX_BACKEND=bwrap，但当前主机无法启动 bwrap 沙箱');
  }
  warnOnce('bwrap-unusable', '工具沙箱 auto 模式：bwrap 无法启动沙箱，shell 回落到宿主执行。');
  return { use: false };
}

/** shell 工具的统一执行入口:默认直通, enforce+bwrap 时切到 OS 沙箱。 */
export async function runShellCommand(command: string, timeout: number, cfg: ShellSandboxConfig): Promise<ShellExecResult> {
  const selected = shouldUseBwrap(cfg);
  if (!selected.use) return hostShell(command, timeout, cfg.workspaceRoot, cfg.env);

  const missing = cfg.allowCommands.filter((name) => !findExecutable(name));
  if (missing.length) {
    warnOnce(
      `bwrap-missing-commands:${missing.join(',')}`,
      `工具沙箱 bwrap 模式：以下命令找不到，因此不可用：${missing.join(', ')}`,
    );
  }

  const args = buildBwrapArgs({
    workspaceRoot: cfg.workspaceRoot,
    command,
    allowCommands: cfg.allowCommands,
    shareNet: cfg.shareNet,
    env: cfg.env,
  });
  return execFileAsync(selected.bwrapPath, args, { timeout, maxBuffer: 1024 * 1024 * 10 });
}

/** 生成可供 spawn() 使用的 shell 执行规格；托管 shell 用它启动前台/后台命令。 */
export function buildShellSpawnSpec(command: string, cfg: ShellSandboxConfig): ShellSpawnSpec {
  const selected = shouldUseBwrap(cfg);
  if (!selected.use) {
    return isWindows
      ? {
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', command],
          cwd: cfg.workspaceRoot,
          env: hostShellEnv(cfg.workspaceRoot, cfg.env),
          backend: 'host',
        }
      : {
          file: '/bin/sh',
          args: ['-c', command],
          cwd: cfg.workspaceRoot,
          env: hostShellEnv(cfg.workspaceRoot, cfg.env),
          backend: 'host',
        };
  }

  const args = buildBwrapArgs({
    workspaceRoot: cfg.workspaceRoot,
    command,
    allowCommands: cfg.allowCommands,
    shareNet: cfg.shareNet,
    env: cfg.env,
  });
  return { file: selected.bwrapPath, args, backend: 'bwrap' };
}

export function describeShellSandbox(cfg: ShellSandboxConfig): string {
  if (cfg.policyMode !== 'enforce') return 'host';
  if (cfg.useHostPath) return 'host (PATH: host)';
  if (cfg.backend === 'none') return 'host (backend: none)';
  return `${cfg.backend}${cfg.shareNet ? ', net: enabled' : ', net: disabled'}`;
}
