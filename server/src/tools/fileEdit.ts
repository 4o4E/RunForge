import { readFile, writeFile } from 'node:fs/promises';
import type { Tool } from './types.js';

export const fileEditTool: Tool = {
  name: 'file_edit',
  description: 'Replace an exact string in a file with a new string. old_string must appear exactly once.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'Exact text to replace (must be unique in the file)' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args) {
    const path = String(args.path ?? '');
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    try {
      const content = await readFile(path, 'utf8');
      const count = content.split(oldStr).length - 1;
      if (count === 0) return `Edit failed: old_string not found in ${path}`;
      if (count > 1) return `Edit failed: old_string appears ${count} times in ${path}; make it unique`;
      await writeFile(path, content.replace(oldStr, newStr), 'utf8');
      return `Edited ${path}`;
    } catch (err) {
      return `Failed to edit ${path}: ${(err as Error).message}`;
    }
  },
};
