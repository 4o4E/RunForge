import { readFile } from 'node:fs/promises';
import type { Tool } from './types.js';
import { resolveToolPath } from './path.js';

export const fileReadTool: Tool = {
  name: 'file_read',
  description: '按 UTF-8 文本读取文件内容。',
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
      const content = await readFile(path, 'utf8');
      return content || '（空文件）';
    } catch (err) {
      return `读取文件失败 ${inputPath}: ${(err as Error).message}`;
    }
  },
};
