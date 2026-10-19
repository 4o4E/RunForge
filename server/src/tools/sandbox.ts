import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { usesShellSessionIsolation, type SandboxBackendName } from '@runforge/contracts';
export type { SandboxBackendName } from '@runforge/contracts';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

export interface ShellSandboxConfig {
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

/** 资源入口目录必须是当前会话自己的实体目录，不能把用户目录链接误当作受控资源挂载。 */
function readonlyResourceDirectories(root: string, names: readonly string[]): string[] {
  return existing(names.map((name) => resolve(root, name))).map((path) => {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
      throw new Error(`托管资源入口不是当前目录树中的实体目录：${path}`);
    }
    return path;
  });
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
      // 实体插件目录已包含在 workspace 绑定中，由其只读资源入口保护。
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
  return spaceRoot ? readonlyResourceDirectories(spaceRoot, ['.plugins']) : [];
}

/** 只挂载本次运行选中的 Skill 和 SDK 内容版本，不暴露空间内其他版本。 */
function selectedManagedTargets(workspaceRoot: string, spaceRoot: string | null, roots: readonly string[]): string[] {
  if (!roots.length) return [];
  if (!spaceRoot) throw new Error('托管资源缺少空间根目录');
  const managedThreadRoot = resolve(workspaceRoot, '.agents');
  const allowedTargets = ['.skills', '.agents'].map((name) => resolve(spaceRoot, name));
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

/** 容器范围保留原文件系统可见性，但逻辑入口和真实资源目标仍强制只读。 */
function buildContainerScopeSpec(command: string, cfg: ShellSandboxConfig, bwrapPath: string): ShellSpawnSpec {
  const workspaceRoot = resolve(cfg.workspaceRoot);
  const threadParent = dirname(workspaceRoot);
  const spaceRoot = cfg.spaceRoot ?? (basename(threadParent) === 'c' ? dirname(threadParent) : null);
  const readonlyWorkspacePaths = readonlyResourceDirectories(workspaceRoot, ['plugins', '.agents', '.skills', '.plugins']);
  const pluginsRoot = resolve(workspaceRoot, 'plugins');
  // 手动终端没有运行锁上下文；容器范围本来可见全部入口，收集既有真实目标只收紧写权限。
  const pluginRoots = unique([
    ...(cfg.pluginRoots ?? []),
    ...(existsSync(pluginsRoot)
      ? readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => resolve(pluginsRoot, entry.name))
      : []),
  ]);
  const readonlyPaths = unique([
    ...readonlyWorkspacePaths,
    ...(spaceRoot ? readonlyResourceDirectories(spaceRoot, ['.plugins', '.skills', '.agents']) : []),
    ...selectedManagedTargets(workspaceRoot, spaceRoot, cfg.managedReadRoots ?? []),
    ...linkedPluginTargets(workspaceRoot, pluginRoots),
  ]);
  const hostPath = hostPathForConfig(cfg);
  const env = hostShellEnv(workspaceRoot, cfg.env, hostPath.envPath);
  // 容器范围保留原容器网络；网络隔离开关只约束完整会话隔离。
  const args = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--clearenv'];
  if (cfg.userFiles) args.push('--bind', cfg.userFiles.source, cfg.userFiles.mountPath);
  for (const path of [...readonlyPaths, ...hostPath.cleanupPaths]) args.push('--ro-bind', path, path);
  args.push('--chdir', workspaceRoot);
  for (const [key, value] of safeEnvEntries(env as Record<string, string>)) {
    args.push('--setenv', key, value);
  }
  args.push('--', '/bin/sh', '-c', command);
  return { file: bwrapPath, args, env, backend: 'bwrap', cleanupPaths: hostPath.cleanupPaths };
}

/** 生成 bwrap 参数;纯函数便于单测,实际执行由 runShellCommand 完成。 */
export function buildBwrapArgs(opts: BwrapOptions): string[] {
  const workspaceRoot = resolve(opts.workspaceRoot);
  const threadParent = dirname(workspaceRoot);
  const spaceRoot = opts.spaceRoot ?? (basename(threadParent) === 'c' ? dirname(threadParent) : null);
  const readonlyWorkspacePaths = readonlyResourceDirectories(workspaceRoot, ['plugins', '.agents', '.skills', '.plugins']);
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

function shouldUseBwrap(cfg: ShellSandboxConfig): { use: true; bwrapPath: string } | { use: false } {
  if (process.platform !== 'linux' && (isWindows || !usesShellSessionIsolation(cfg.backend, cfg.useHostPath))) return { use: false };
  if (process.platform !== 'linux') {
    if (cfg.backend === 'bwrap') throw new Error('bwrap 沙箱需要 Linux 环境');
    warnOnce('bwrap-non-linux', '工具沙箱 auto 模式：当前不是 Linux，shell 回落到宿主执行。');
    return { use: false };
  }

  const bwrapPath = findExecutable('bwrap');
  if (!bwrapPath) {
    throw new Error('工具沙箱无法启动：PATH 中找不到 bwrap；Linux Shell 必须启用资源只读保护，请修复容器配置');
  }
  if (canStartBwrap(bwrapPath)) return { use: true, bwrapPath };
  throw new Error('工具沙箱无法启动：当前主机无法使用 bwrap；Linux Shell 必须启用资源只读保护，请修复容器权限配置');
}

/** 两种 Linux 访问范围统一经 bwrap 执行；临时命令门面在进程结束后清理。 */
export async function runShellCommand(command: string, timeout: number, cfg: ShellSandboxConfig): Promise<ShellExecResult> {
  const spec = buildShellSpawnSpec(command, cfg);
  try {
    return await execFileAsync(spec.file, spec.args, {
      timeout,
      maxBuffer: 1024 * 1024 * 10,
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: isWindows,
    });
  } finally {
    cleanupTempPaths(spec.cleanupPaths ?? []);
  }
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
  if (!usesShellSessionIsolation(cfg.backend, cfg.useHostPath)) return buildContainerScopeSpec(command, cfg, selected.bwrapPath);

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
  return { file: selected.bwrapPath, args, env: hostShellEnv(cfg.workspaceRoot, cfg.env, cfg.envPath), backend: 'bwrap' };
}

export function describeShellSandbox(cfg: ShellSandboxConfig): string {
  const sessionIsolation = usesShellSessionIsolation(cfg.backend, cfg.useHostPath);
  if (process.platform === 'linux') {
    return `bwrap（资源只读，${sessionIsolation ? '完整会话隔离' : '容器范围访问'}），网络${!sessionIsolation || cfg.shareNet ? '启用' : '禁用'}`;
  }
  if (!sessionIsolation || isWindows) return '宿主执行（当前平台未提供资源只读隔离）';
  return `${cfg.backend}（非 Linux 平台不提供 bwrap 资源只读隔离）`;
}
