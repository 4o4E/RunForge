import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Tool } from './types.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', '.cache']);

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents with a regular expression. Returns matching lines with file path and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Directory to search (default: cwd)' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match' },
    },
    required: ['pattern'],
  },
  async run(args) {
    const root = String(args.path ?? process.cwd());
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern ?? ''), args.ignore_case ? 'i' : undefined);
    } catch (err) {
      return `Invalid regex: ${(err as Error).message}`;
    }
    const results: string[] = [];
    for await (const file of walkFiles(root)) {
      if (results.length >= 200) break;
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(root, file).split(sep).join('/');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= 200) break;
        }
      }
    }
    return results.length ? results.join('\n') : '(no matches)';
  },
};
