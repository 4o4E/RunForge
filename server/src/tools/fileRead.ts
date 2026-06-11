import { readFile } from 'node:fs/promises';
import type { Tool } from './types.js';

export const fileReadTool: Tool = {
  name: 'file_read',
  description: 'Read the contents of a file as UTF-8 text.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
    },
    required: ['path'],
  },
  async run(args) {
    const path = String(args.path ?? '');
    try {
      const content = await readFile(path, 'utf8');
      return content || '(empty file)';
    } catch (err) {
      return `Failed to read ${path}: ${(err as Error).message}`;
    }
  },
};
