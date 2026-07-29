import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from './types.js';
import { resolveToolPath } from './path.js';

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: '写入文件（创建或覆盖）并在需要时自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const inputPath = String(args.path ?? '');
    const path = resolveToolPath(inputPath, ctx);
    const content = String(args.content ?? '');
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return `已写入 ${content.length} 字节到 ${inputPath}`;
    } catch (err) {
      return `写入文件失败 ${inputPath}: ${(err as Error).message}`;
    }
  },
};
