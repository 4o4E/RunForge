import { readFile, writeFile } from 'node:fs/promises';
import type { Tool } from './types.js';
import { resolveToolPath } from './path.js';

export const fileEditTool: Tool = {
  name: 'file_edit',
  description: '把文件中的精确字符串替换为新字符串；old_string 必须在文件中只出现一次。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要编辑的文件路径' },
      old_string: { type: 'string', description: '要替换的精确文本，必须在文件中唯一' },
      new_string: { type: 'string', description: '替换后的文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const inputPath = String(args.path ?? '');
    const path = resolveToolPath(inputPath, ctx);
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    try {
      const content = await readFile(path, 'utf8');
      const count = content.split(oldStr).length - 1;
      if (count === 0) return `编辑失败：在 ${inputPath} 中没有找到 old_string`;
      if (count > 1) return `编辑失败：old_string 在 ${inputPath} 中出现了 ${count} 次，请提供唯一文本`;
      await writeFile(path, content.replace(oldStr, newStr), 'utf8');
      return `已编辑 ${inputPath}`;
    } catch (err) {
      return `编辑文件失败 ${inputPath}: ${(err as Error).message}`;
    }
  },
};
