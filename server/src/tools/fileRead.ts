import { readFile, stat } from 'node:fs/promises';
import type { Tool } from './types.js';
import { resolveToolPath } from './path.js';
import { isImageMediaType, mediaTypeFromPath, toRemotePath } from '../files/workspace.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const fileReadTool: Tool = {
  name: 'file_read',
  description: '按 UTF-8 文本读取文件内容；读取 PNG、JPEG 或 WebP 时将图片交给模型分析。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件的绝对路径或相对路径' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const inputPath = String(args.path ?? '');
    const path = resolveToolPath(inputPath, ctx);
    try {
      const info = await stat(path);
      const mediaType = mediaTypeFromPath(path);
      if (info.isFile() && isImageMediaType(mediaType) && ['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) {
        if (info.size > MAX_IMAGE_BYTES) throw new Error(`图片文件超过 ${MAX_IMAGE_BYTES} 字节上限`);
        const data = await readFile(path);
        return {
          text: `已读取图片：${inputPath}`,
          contentParts: [{
            type: 'image',
            data: data.toString('base64'),
            mimeType: mediaType,
            path: toRemotePath(path, ctx?.settings?.workspaceRoot ?? path),
            name: inputPath,
          }],
        };
      }
      const content = await readFile(path, 'utf8');
      return content || '（空文件）';
    } catch (err) {
      return `读取文件失败 ${inputPath}: ${(err as Error).message}`;
    }
  },
};
