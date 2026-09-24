import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LlmContentPart } from '../../llm/types.js';
import type { ToolRunContext } from '../types.js';
import { toRemotePath } from '../../files/workspace.js';
import { isWithin } from '../policy.js';

export const MAX_MEDIA_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 8;
export const MAX_VIDEO_FRAMES = 8;
export const MAX_TEXT_CHARS = 40_000;

export function throwIfAborted(ctx?: ToolRunContext): void {
  ctx?.abortSignal?.throwIfAborted();
}

export function workspaceRoot(ctx?: ToolRunContext): string {
  const root = ctx?.settings?.workspaceRoot;
  if (!root) throw new Error('file_read 多模态读取需要当前工作区路径');
  return resolve(root);
}

export async function prepareOutputRoot(ctx?: ToolRunContext): Promise<string> {
  const root = resolve(workspaceRoot(ctx), '.runforge', 'media-read');
  await mkdir(root, { recursive: true });
  const actual = await realpath(root);
  if (!isWithin(workspaceRoot(ctx), actual)) throw new Error('多模态派生文件目录超出当前工作区');
  return actual;
}

export async function saveDerivedImage(
  bytes: Uint8Array,
  sourcePath: string,
  ctx?: ToolRunContext,
  suffix = '.png',
): Promise<Extract<LlmContentPart, { type: 'image' }>> {
  const root = await prepareOutputRoot(ctx);
  const stem = basename(sourcePath, extname(sourcePath)).replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80) || 'media';
  const path = join(root, `${stem}-${randomUUID()}${suffix}`);
  await writeFile(path, bytes, { flag: 'wx' });
  return {
    type: 'image',
    data: Buffer.from(bytes).toString('base64'),
    mimeType: suffix === '.webp' ? 'image/webp' : 'image/png',
    path: toRemotePath(path, workspaceRoot(ctx)),
    name: basename(path),
  };
}

export async function readTextFile(path: string): Promise<string> {
  const file = await open(path, 'r');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const buffer = Buffer.alloc(8192);
  let text = '';
  try {
    while (text.length <= MAX_TEXT_CHARS) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    }
  } finally {
    await file.close();
  }
  if (text.length > MAX_TEXT_CHARS) {
    return `${text.slice(0, MAX_TEXT_CHARS)}\n\n（内容已截断；本次只读取前 ${MAX_TEXT_CHARS} 个字符）`;
  }
  return text || '（空文件）';
}
