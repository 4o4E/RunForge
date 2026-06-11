import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from './types.js';

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: 'Write (create or overwrite) a file with the given content. Creates parent directories as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  async run(args) {
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return `Wrote ${content.length} bytes to ${path}`;
    } catch (err) {
      return `Failed to write ${path}: ${(err as Error).message}`;
    }
  },
};
