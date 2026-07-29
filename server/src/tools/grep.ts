import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Tool } from './types.js';
import { resolveToolRoot } from './path.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', '.cache', '.agents', '.skills', '.venv', '.npm', '.rustup']);

function sortEntries(entries: Dirent[]): Dirent[] {
  return entries.sort((a, b) => {
    const hiddenA = a.name.startsWith('.');
    const hiddenB = b.name.startsWith('.');
    return Number(hiddenA) - Number(hiddenB) || a.name.localeCompare(b.name);
  });
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of sortEntries(entries)) {
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

export const grepTool: Tool = {
  name: 'grep',
  description: '使用正则表达式搜索文件内容，返回带文件路径和行号的匹配行。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的正则表达式' },
      path: { type: 'string', description: '搜索目录，默认是当前目录' },
      ignore_case: { type: 'boolean', description: '是否忽略大小写' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const root = resolveToolRoot(args.path, ctx);
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern ?? ''), args.ignore_case ? 'i' : undefined);
    } catch (err) {
      return `正则表达式无效：${(err as Error).message}`;
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
    return results.length ? results.join('\n') : '（没有匹配项）';
  },
};
