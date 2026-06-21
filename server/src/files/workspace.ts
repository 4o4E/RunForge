import { createReadStream } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isWithin } from '../tools/policy.js';

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
  return 'application/octet-stream';
}

export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

export function streamWorkspaceFile(path: string) {
  return createReadStream(path);
}
