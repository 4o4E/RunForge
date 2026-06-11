import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Tool } from './types.js';

// Convert a simple glob (supports **, *, ?) to a RegExp.
// `**/` matches zero or more leading directory segments (so "**/*.ts" also
// matches top-level files); `**` matches across separators; `*` stays within one.
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?'; // **/ → optional directory prefix
        i += 2;
      } else {
        re += '.*'; // ** → any, including separators
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

const IGNORE = new Set(['node_modules', '.git', 'dist', '.cache']);

async function walk(dir: string, root: string, out: string[], limit: number) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out, limit);
    else out.push(relative(root, full).split(sep).join('/'));
  }
}

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern (supports **, *, ?). Returns matching paths relative to the search directory.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      path: { type: 'string', description: 'Directory to search from (default: cwd)' },
    },
    required: ['pattern'],
  },
  async run(args) {
    const pattern = String(args.pattern ?? '');
    const root = String(args.path ?? process.cwd());
    const all: string[] = [];
    await walk(root, root, all, 5000);
    const re = globToRegExp(pattern);
    const matches = all.filter((p) => re.test(p)).slice(0, 200);
    return matches.length ? matches.join('\n') : '(no matches)';
  },
};
