import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import { isWithin } from '../tools/policy.js';

const SMALL_FILE_BYTES = 200 * 1024;
const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1000;

export const filesApi = Router();

function workspaceRoot(): string {
  return resolve(config.tools.workspaceRoot);
}

function normalizeRemotePath(raw: unknown): string {
  const input = String(raw ?? '.').trim() || '.';
  const root = workspaceRoot();
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!isWithin(root, absolute)) {
    throw new Error(`path is outside workspace: ${input}`);
  }
  return absolute;
}

function toRemotePath(abs: string): string {
  const rel = relative(workspaceRoot(), abs);
  return rel ? rel.split('\\').join('/') : '.';
}

function parentRemotePath(abs: string): string | null {
  const root = workspaceRoot();
  if (resolve(abs) === root) return null;
  return toRemotePath(dirname(abs));
}

filesApi.get('/list', async (req, res) => {
  try {
    const dir = normalizeRemotePath(req.query.path);
    const info = await stat(dir);
    if (!info.isDirectory()) return res.status(400).json({ error: 'path is not a directory' });

    const entries = await Promise.all(
      (await readdir(dir)).map(async (name) => {
        const abs = join(dir, name);
        const s = await stat(abs);
        return {
          name,
          path: toRemotePath(abs),
          type: s.isDirectory() ? 'dir' : 'file',
          size: s.size,
          updatedAt: s.mtime.toISOString(),
        };
      }),
    );

    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: toRemotePath(dir), parent: parentRemotePath(dir), entries });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesApi.post('/upload', async (req, res) => {
  try {
    const targetPath = normalizeRemotePath(req.body?.path);
    const contentBase64 = String(req.body?.contentBase64 ?? '');
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 is required' });

    const content = Buffer.from(contentBase64, 'base64');
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
    res.status(201).json({ path: toRemotePath(targetPath), size: content.length });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesApi.get('/preview', async (req, res) => {
  try {
    const file = normalizeRemotePath(req.query.path);
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path is not a file' });

    const startLine = Math.max(1, Number(req.query.startLine ?? 1) || 1);
    const limit = Math.min(MAX_LINE_LIMIT, Math.max(1, Number(req.query.limit ?? DEFAULT_LINE_LIMIT) || DEFAULT_LINE_LIMIT));

    if (info.size <= SMALL_FILE_BYTES) {
      const text = await readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      return res.json({
        path: toRemotePath(file),
        size: info.size,
        mode: 'full',
        startLine: 1,
        lines,
        nextLine: null,
        hasMore: false,
      });
    }

    const lines: string[] = [];
    let lineNo = 0;
    let hasMore = false;
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < startLine) continue;
      if (lines.length >= limit) {
        hasMore = true;
        rl.close();
        break;
      }
      lines.push(line);
    }

    res.json({
      path: toRemotePath(file),
      size: info.size,
      mode: 'chunk',
      startLine,
      lines,
      nextLine: hasMore ? startLine + lines.length : null,
      hasMore,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

