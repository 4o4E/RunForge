import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxBackendName } from '@runforge/contracts';
export type { SandboxBackendName } from '@runforge/contracts';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

export interface ShellSandboxConfig {
  policyMode: 'off' | 'enforce';
  backend: SandboxBackendName;
  workspaceRoot: string;
  useHostPath: boolean;
  envPath?: string;
  shareNet: boolean;
  env?: Record<string, string>;
  pluginExecutables?: Array<{ name: string; path: string }>;
  pluginRoots?: string[];
  managedReadRoots?: string[];
  spaceRoot?: string;
  userFiles?: { source: string; mountPath: string };
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
  cleanupPaths?: string[];
}

interface BwrapOptions {
  workspaceRoot: string;
  command: string;
  shareNet: boolean;
  envPath?: string;
  env?: Record<string, string>;
  pluginExecutables?: Array<{ name: string; path: string }>;
  pluginRoots?: string[];
  managedReadRoots?: string[];
  spaceRoot?: string;
  userFiles?: { source: string; mountPath: string };
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

/**
 * 业务插件在 thread 中是指向内容哈希快照的符号链接。bwrap 只绑定 thread workspace
 * 时看不到链接指向的外部 Docker volume，因此把服务端已经物化的链接目标按原路径只读绑定。
 */
function linkedPluginTargets(workspaceRoot: string, pluginRoots: readonly string[]): string[] {
  const root = resolve(workspaceRoot, 'plugins');
  if (!existsSync(root)) return [];
  const targets: string[] = [];
  for (const pluginRoot of pluginRoots) {
    const path = resolve(pluginRoot);
    try {
      if (dirname(path) !== root) throw new Error(`业务插件根目录不属于当前 workspace：${path}`);
      const stats = lstatSync(path);
      // 没有正式快照的旧 run 可以继续使用 thread 内遗留实体目录；它已经包含在 workspace bind 中。
      if (stats.isDirectory()) continue;
      if (!stats.isSymbolicLink()) throw new Error(`业务插件根目录不是目录或受控链接：${path}`);
      targets.push(realpathSync(path));
    } catch {
      throw new Error(`业务插件根目录无法解析：${path}`);
    }
  }
  return unique(targets);
}

/** 空间的插件目录只包含版本链接；目标快照仍按当前 run 的插件锁单独挂载。 */
function managedPluginLinks(spaceRoot: string | null): string[] {
  return spaceRoot ? existing([resolve(spaceRoot, '.plugins')]) : [];
}

/** 只挂载本次运行选中的 Skill、Workflow、SDK 内容版本，不暴露空间内其他版本。 */
function selectedManagedTargets(workspaceRoot: string, spaceRoot: string | null, roots: readonly string[]): string[] {
  if (!roots.length) return [];
  if (!spaceRoot) throw new Error('托管资源缺少空间根目录');
  const managedThreadRoot = resolve(workspaceRoot, '.agents');
  const allowedTargets = ['.skills', '.workflows', '.agents'].map((name) => resolve(spaceRoot, name));
  return unique(roots.map((root) => {
    const path = resolve(root);
    if (path !== managedThreadRoot && !path.startsWith(`${managedThreadRoot}/`)) {
      throw new Error(`托管资源入口不属于当前会话：${path}`);
    }
    const target = realpathSync(path);
    if (!allowedTargets.some((allowed) => target === allowed || target.startsWith(`${allowed}/`))) {
      throw new Error(`托管资源目标不属于当前空间：${path}`);
    }
    return target;
  }));
}

function safeEnvEntries(env: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(env ?? {}).filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string');
}

function cleanupTempPaths(paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // 临时 PATH 清理失败不影响命令结果；下次系统 tmp 清理会兜底。
    }
  }
}

function hostPathForConfig(cfg: ShellSandboxConfig): { envPath: string; cleanupPaths: string[] } {
  const envPath = cfg.envPath ?? process.env.PATH ?? '';
  const pluginCommands = cfg.pluginExecutables ?? [];
  if (!pluginCommands.length) return { envPath, cleanupPaths: [] };

  const dir = mkdtempSync(join(tmpdir(), 'runforge-shell-path-'));
  const linked = new Set<string>();
  for (const command of pluginCommands) {
    if (linked.has(command.name)) continue;
    linked.add(command.name);
    symlinkSync(resolve(command.path), join(dir, command.name));
  }
  return { envPath: `${dir}${delimiter}${envPath}`, cleanupPaths: [dir] };
}

/** 生成 bwrap 参数;纯函数便于单测,实际执行由 runShellCommand 完成。 */
export function buildBwrapArgs(opts: BwrapOptions): string[] {
  const workspaceRoot = resolve(opts.workspaceRoot);
  const threadParent = dirname(workspaceRoot);
  const spaceRoot = opts.spaceRoot ?? (basename(threadParent) === 'c' ? dirname(threadParent) : null);
  const readonlyWorkspacePaths = existing([resolve(workspaceRoot, 'plugins'), resolve(workspaceRoot, '.agents')]);
  const readonlySpacePaths = managedPluginLinks(spaceRoot);
  const managedTargets = selectedManagedTargets(workspaceRoot, spaceRoot, opts.managedReadRoots ?? []);
  const linkedReadonlyTargets = linkedPluginTargets(workspaceRoot, opts.pluginRoots ?? []);
  const envPath = opts.envPath ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  // bwrap 只投射容器里的系统文件与 PATH 目录；会话数据仍按当前 workspace/user 精确绑定。
  const systemDirs = existing(['/usr', '/bin', '/sbin', '/lib', '/lib64']);
  const configuredPathDirs = unique(envPath.split(delimiter).filter(isAbsolute).map((path) => resolve(path)));
  const pathDirs = configuredPathDirs.filter((path) =>
    !systemDirs.some((dir) => path === dir || path.startsWith(`${dir}/`))
    && path !== workspaceRoot && !path.startsWith(`${workspaceRoot}/`)
    && !(opts.userFiles && (path === opts.userFiles.mountPath || path.startsWith(`${opts.userFiles.mountPath}/`))));
  const existingPathDirs = pathDirs.filter(existsSync);
  const pathBindings = existingPathDirs.map((path) => ({ source: realpathSync(path), dest: path }));
  // PATH 目录由 bwrap 挂载；先检查并固定真实源路径，避免符号链接变化后引入其他会话或用户目录。
  for (const target of [...pathDirs, ...pathBindings.map((binding) => binding.source)]) {
    const outsideCurrentWorkspace = target === '/w' || (target.startsWith('/w/')
      && target !== workspaceRoot && !target.startsWith(`${workspaceRoot}/`));
    const outsideCurrentUser = target === '/u' || (target.startsWith('/u/')
      && !(opts.userFiles && (target === opts.userFiles.mountPath || target.startsWith(`${opts.userFiles.mountPath}/`))));
    if (target === '/' || outsideCurrentWorkspace || outsideCurrentUser) {
      throw new Error('PATH 不能挂载容器根目录或其他会话、用户的数据目录');
    }
  }
  const pluginCommands = (opts.pluginExecutables ?? []).map((item) => ({
    name: item.name,
    source: resolve(item.path),
    dest: `/runforge/plugin-bin/${item.name}`,
  }));
  const etcFiles = existing(
    opts.shareNet
      ? ['/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/hosts', '/etc/resolv.conf', '/etc/nsswitch.conf']
      : ['/etc/ld.so.cache', '/etc/passwd', '/etc/group'],
  );
  const extraReadOnlyPaths = existing(['/etc/alternatives', ...(opts.shareNet ? ['/etc/ssl/certs'] : [])]);
  const shellPath = pluginCommands.length ? `/runforge/plugin-bin:${envPath}` : envPath;
  const mountDirs = unique([
    ...systemDirs.flatMap(parentDirs),
    ...systemDirs,
    ...existingPathDirs.flatMap(parentDirs),
    ...existingPathDirs,
    ...etcFiles.flatMap(parentDirs),
    ...extraReadOnlyPaths.flatMap(parentDirs),
    ...parentDirs('/bin/sh'),
    ...pluginCommands.flatMap((command) => parentDirs(command.dest)),
    ...parentDirs(workspaceRoot),
    ...(opts.userFiles ? parentDirs(opts.userFiles.mountPath) : []),
    ...readonlyWorkspacePaths.flatMap(parentDirs),
    ...readonlySpacePaths.flatMap(parentDirs),
    ...managedTargets.flatMap(parentDirs),
    ...linkedReadonlyTargets.flatMap(parentDirs),
  ]);

  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--tmpfs', '/'];
  if (opts.shareNet) args.push('--share-net');
  args.push('--clearenv');

  for (const dir of mountDirs) args.push('--dir', dir);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const dir of systemDirs) args.push('--ro-bind', dir, dir);
  for (const binding of pathBindings) args.push('--ro-bind', binding.source, binding.dest);
  for (const file of etcFiles) args.push('--ro-bind', file, file);
  for (const path of extraReadOnlyPaths) args.push('--ro-bind', path, path);
  for (const command of pluginCommands) args.push('--symlink', command.source, command.dest);

  args.push('--bind', workspaceRoot, workspaceRoot);
  if (opts.userFiles) args.push('--bind', opts.userFiles.source, opts.userFiles.mountPath);
  for (const path of readonlyWorkspacePaths) args.push('--ro-bind', path, path);
  for (const path of readonlySpacePaths) args.push('--ro-bind', path, path);
  for (const path of managedTargets) args.push('--ro-bind', path, path);
  for (const path of linkedReadonlyTargets) args.push('--ro-bind', path, path);
  args.push('--chdir', workspaceRoot);
  args.push('--setenv', 'PATH', shellPath);
  args.push('--setenv', 'HOME', workspaceRoot, '--setenv', 'PWD', workspaceRoot);
  for (const [key, value] of safeEnvEntries(opts.env)) args.push('--setenv', key, value);
  args.push('--', '/bin/sh', '-c', opts.command);
  return args;
}

function hostShellEnv(workspaceRoot: string, env?: Record<string, string>, envPath = process.env.PATH ?? ''): NodeJS.ProcessEnv {
  return {
    PATH: envPath || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...env,
    HOME: workspaceRoot,
    PWD: workspaceRoot,
  };
}

function hostShell(command: string, timeout: number, workspaceRoot: string, env?: Record<string, string>, envPath?: string): Promise<ShellExecResult> {
  const childEnv = hostShellEnv(workspaceRoot, env, envPath);
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
  if (!selected.use) {
    if (cfg.userFiles) throw new Error('用户文件目录只允许在 bwrap 沙箱中挂载');
    const hostPath = hostPathForConfig(cfg);
    try {
      return await hostShell(command, timeout, cfg.workspaceRoot, cfg.env, hostPath.envPath);
    } finally {
      cleanupTempPaths(hostPath.cleanupPaths);
    }
  }

  const args = buildBwrapArgs({
    workspaceRoot: cfg.workspaceRoot,
    command,
    shareNet: cfg.shareNet,
    envPath: cfg.envPath,
    env: cfg.env,
    pluginExecutables: cfg.pluginExecutables,
    pluginRoots: cfg.pluginRoots,
    managedReadRoots: cfg.managedReadRoots,
    spaceRoot: cfg.spaceRoot,
    userFiles: cfg.userFiles,
  });
  return execFileAsync(selected.bwrapPath, args, { timeout, maxBuffer: 1024 * 1024 * 10 });
}

/** 生成可供 spawn() 使用的 shell 执行规格；托管 shell 用它启动前台/后台命令。 */
export function buildShellSpawnSpec(command: string, cfg: ShellSandboxConfig): ShellSpawnSpec {
  const selected = shouldUseBwrap(cfg);
  if (!selected.use) {
    if (cfg.userFiles) throw new Error('用户文件目录只允许在 bwrap 沙箱中挂载');
    const hostPath = hostPathForConfig(cfg);
    return isWindows
      ? {
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', command],
          cwd: cfg.workspaceRoot,
          env: hostShellEnv(cfg.workspaceRoot, cfg.env, hostPath.envPath),
          backend: 'host',
          cleanupPaths: hostPath.cleanupPaths,
        }
      : {
          file: '/bin/sh',
          args: ['-c', command],
          cwd: cfg.workspaceRoot,
          env: hostShellEnv(cfg.workspaceRoot, cfg.env, hostPath.envPath),
          backend: 'host',
          cleanupPaths: hostPath.cleanupPaths,
        };
  }

  const args = buildBwrapArgs({
    workspaceRoot: cfg.workspaceRoot,
    command,
    shareNet: cfg.shareNet,
    envPath: cfg.envPath,
    env: cfg.env,
    pluginExecutables: cfg.pluginExecutables,
    pluginRoots: cfg.pluginRoots,
    managedReadRoots: cfg.managedReadRoots,
    spaceRoot: cfg.spaceRoot,
    userFiles: cfg.userFiles,
  });
  return { file: selected.bwrapPath, args, backend: 'bwrap' };
}

export function describeShellSandbox(cfg: ShellSandboxConfig): string {
  if (cfg.policyMode !== 'enforce') return 'host';
  if (cfg.useHostPath) return 'host (container PATH)';
  if (cfg.backend === 'none') return 'host (backend: none)';
  return `${cfg.backend}${cfg.shareNet ? ', net: enabled' : ', net: disabled'}`;
}
