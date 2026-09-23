import { createReadStream } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { isWithin } from '../tools/policy.js';

export class WorkspacePathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathAccessError';
  }
}

export function workspaceRoot(root: string): string {
  return resolve(root);
}

export function normalizeRemotePath(raw: unknown, configuredRoot: string): string {
  const input = String(raw ?? '.').trim() || '.';
  const root = workspaceRoot(configuredRoot);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!isWithin(root, absolute)) {
    throw new Error(`路径超出 workspace：${input}`);
  }
  return absolute;
}

function isReservedThreadPath(root: string, target: string): boolean {
  const first = relative(root, target).split(sep)[0]?.toLowerCase();
  return ['.agents', '.skills', '.workflows', '.plugins', 'plugins'].includes(first ?? '');
}

function isControlledLinkPath(root: string, linkPath: string): boolean {
  const parts = relative(root, linkPath).split(sep).map((part) => part.toLowerCase());
  return (parts[0] === 'plugins' && parts.length === 2)
    || (parts[0] === '.agents' && ['skills', 'workflows'].includes(parts[1] ?? '') && parts.length === 3)
    || (parts[0] === '.agents' && parts[1] === 'runforge-workload-sdk' && parts.length === 2);
}

/**
 * 在实际文件操作前检查每个路径段的真实位置。Agent 只可跟随服务端约定位置上的
 * 资源链接，且链接目标必须属于本次运行选中的资源根；普通用户文件不能借符号链接越界。
 */
export async function resolveWorkspaceFilePath(
  configuredRoot: string,
  raw: unknown,
  options: { access: 'read' | 'write'; managedReadRoots?: readonly string[]; pluginRoots?: readonly string[] },
): Promise<string> {
  const root = workspaceRoot(configuredRoot);
  const target = normalizeRemotePath(raw, root);
  const rootReal = await realpath(root);
  const allowedRoots = options.access === 'read'
    ? await Promise.all([...(options.managedReadRoots ?? []), ...(options.pluginRoots ?? [])].map((path) => realpath(path)))
    : [];
  if (options.access === 'write' && isReservedThreadPath(root, target)) {
    throw new WorkspacePathAccessError(`托管资源只读：${relative(root, target)}`);
  }

  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    const next = resolve(current, part);
    let link = false;
    try {
      link = (await lstat(next)).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (link) {
      if (options.access !== 'read' || !isControlledLinkPath(root, next)) {
        throw new WorkspacePathAccessError(`不允许通过此符号链接访问文件：${relative(root, next)}`);
      }
      current = await realpath(next);
      if (!allowedRoots.some((allowed) => isWithin(allowed, current))) {
        throw new WorkspacePathAccessError(`符号链接不属于当前运行选中的资源：${relative(root, next)}`);
      }
      continue;
    }
    current = next;
    try {
      current = await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!isWithin(rootReal, current) && !allowedRoots.some((allowed) => isWithin(allowed, current))) {
      throw new WorkspacePathAccessError(`真实路径超出当前会话和选中资源：${relative(root, target)}`);
    }
  }
  if (isReservedThreadPath(root, target) && !allowedRoots.some((allowed) => isWithin(allowed, current))) {
    throw new WorkspacePathAccessError(`托管路径不属于当前运行选中的资源：${relative(root, target)}`);
  }
  return target;
}

/** Web 编辑器只访问会话内普通文件，不公开服务端托管目录或任何符号链接。 */
export async function resolveWebWorkspaceFilePath(
  configuredRoot: string,
  raw: unknown,
): Promise<string> {
  const root = workspaceRoot(configuredRoot);
  const target = normalizeRemotePath(raw, root);
  if (isReservedThreadPath(root, target)) {
    throw new WorkspacePathAccessError(`托管资源不属于用户文件：${relative(root, target)}`);
  }
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new WorkspacePathAccessError(`Web 文件接口不允许通过符号链接访问：${relative(root, current)}`);
      }
    } catch (error) {
      if (error instanceof WorkspacePathAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const rootReal = await realpath(root);
  let targetReal = target;
  try {
    targetReal = await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!isWithin(rootReal, targetReal)) {
    throw new WorkspacePathAccessError('真实路径超出当前会话');
  }
  return target;
}

export function toRemotePath(abs: string, configuredRoot: string): string {
  const rel = relative(workspaceRoot(configuredRoot), abs);
  return rel ? rel.split('\\').join('/') : '.';
}

export function mediaTypeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.ogv')) return 'video/ogg';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.m4v')) return 'video/x-m4v';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.weba')) return 'audio/webm';
  return 'application/octet-stream';
}

export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

export function streamWorkspaceFile(path: string, options: { start?: number; end?: number } = {}) {
  return createReadStream(path, options);
}
