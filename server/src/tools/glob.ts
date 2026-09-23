import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Tool } from './types.js';
import { resolveToolRoot } from './path.js';
import { isWithin } from './policy.js';

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

const IGNORE = new Set(['node_modules', '.git', 'dist', '.cache', '.agents', '.skills', '.venv', '.npm', '.rustup']);

function sortEntries(entries: Dirent[]): Dirent[] {
  return entries.sort((a, b) => {
    const hiddenA = a.name.startsWith('.');
    const hiddenB = b.name.startsWith('.');
    return Number(hiddenA) - Number(hiddenB) || a.name.localeCompare(b.name);
  });
}

async function walkMatches(dir: string, root: string, re: RegExp, out: string[], limit: number) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of sortEntries(entries)) {
    if (out.length >= limit) return;
    if (e.isSymbolicLink()) continue;
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkMatches(full, root, re, out, limit);
      continue;
    }
    const rel = relative(root, full).split(sep).join('/');
    if (re.test(rel)) out.push(rel);
  }
}

export const globTool: Tool = {
  name: 'glob',
  description: '按 glob 模式查找文件（支持 **、*、?）；用户目录中的结果返回绝对路径。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，例如 "src/**/*.ts"' },
      path: { type: 'string', description: '搜索起始目录，默认是当前目录' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? '');
    const root = await resolveToolRoot(args.path, ctx);
    const re = globToRegExp(pattern);
    const matches: string[] = [];
    await walkMatches(root, root, re, matches, 200);
    const userDirectory = ctx?.userFiles && isWithin(ctx.userFiles.source, root);
    return matches.length
      ? matches.map((match) => userDirectory ? join(root, match).split(sep).join('/') : match).join('\n')
      : '（没有匹配项）';
  },
};
