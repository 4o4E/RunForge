import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { getToolSettings } from '../settings.js';
import { isWithin } from '../tools/policy.js';

const SMALL_FILE_BYTES = 200 * 1024;
const MAX_RENDER_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1000;
const MAX_PREVIEW_LINE_CHARS = 12_000;

export const filesApi = Router();

function workspaceRoot(root: string): string {
  return resolve(root);
}

function normalizeRemotePath(raw: unknown, configuredRoot: string): string {
  const input = String(raw ?? '.').trim() || '.';
  const root = workspaceRoot(configuredRoot);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!isWithin(root, absolute)) {
    throw new Error(`路径超出 workspace：${input}`);
  }
  return absolute;
}

function toRemotePath(abs: string, configuredRoot: string): string {
  const rel = relative(workspaceRoot(configuredRoot), abs);
  return rel ? rel.split('\\').join('/') : '.';
}

function parentRemotePath(abs: string, configuredRoot: string): string | null {
  const root = workspaceRoot(configuredRoot);
  if (resolve(abs) === root) return null;
  return toRemotePath(dirname(abs), configuredRoot);
}

function previewLine(line: string): string {
  if (line.length <= MAX_PREVIEW_LINE_CHARS) return line;
  return `${line.slice(0, MAX_PREVIEW_LINE_CHARS)} ... [预览已截断 ${line.length - MAX_PREVIEW_LINE_CHARS} 个字符]`;
}

export function previewTextLines(text: string, options: { truncateLongLines?: boolean } = {}): string[] {
  const truncateLongLines = options.truncateLongLines !== false;
  return text.split(/\r?\n/).map((line) => (truncateLongLines ? previewLine(line) : line));
}

filesApi.get('/info', async (_req, res) => {
  const settings = await getToolSettings();
  const root = workspaceRoot(settings.workspaceRoot);
  res.json({ workspaceRoot: root, rootPath: toRemotePath(root, settings.workspaceRoot) });
});

filesApi.get('/list', async (req, res) => {
  try {
    const settings = await getToolSettings();
    const dir = normalizeRemotePath(req.query.path, settings.workspaceRoot);
    const info = await stat(dir);
    if (!info.isDirectory()) return res.status(400).json({ error: 'path 不是目录' });

    const entries = await Promise.all(
      (await readdir(dir)).map(async (name) => {
        const abs = join(dir, name);
        const s = await stat(abs);
        return {
          name,
          path: toRemotePath(abs, settings.workspaceRoot),
          type: s.isDirectory() ? 'dir' : 'file',
          size: s.size,
          updatedAt: s.mtime.toISOString(),
        };
      }),
    );

    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: toRemotePath(dir, settings.workspaceRoot), parent: parentRemotePath(dir, settings.workspaceRoot), entries });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesApi.post('/upload', async (req, res) => {
  try {
    const settings = await getToolSettings();
    const targetPath = normalizeRemotePath(req.body?.path, settings.workspaceRoot);
    const contentBase64 = String(req.body?.contentBase64 ?? '');
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 为必填' });

    const content = Buffer.from(contentBase64, 'base64');
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
    res.status(201).json({ path: toRemotePath(targetPath, settings.workspaceRoot), size: content.length });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesApi.get('/preview', async (req, res) => {
  try {
    const settings = await getToolSettings();
    const file = normalizeRemotePath(req.query.path, settings.workspaceRoot);
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });

    const startLine = Math.max(1, Number(req.query.startLine ?? 1) || 1);
    const limit = Math.min(MAX_LINE_LIMIT, Math.max(1, Number(req.query.limit ?? DEFAULT_LINE_LIMIT) || DEFAULT_LINE_LIMIT));
    const renderMode = req.query.render === '1';

    if (renderMode && info.size > MAX_RENDER_FILE_BYTES) {
      return res.status(413).json({ error: `文件超过渲染上限 ${MAX_RENDER_FILE_BYTES} 字节` });
    }

    if (info.size <= SMALL_FILE_BYTES || renderMode) {
      const text = await readFile(file, 'utf8');
      // 渲染模式必须使用原文；截断后的 HTML/Markdown 会变成另一份损坏内容。
      const lines = previewTextLines(text, { truncateLongLines: !renderMode });
      return res.json({
        path: toRemotePath(file, settings.workspaceRoot),
        size: info.size,
        mode: 'full',
        startLine: 1,
        lines,
        totalLines: lines.length,
        nextLine: null,
        hasMore: false,
      });
    }

    const lines: string[] = [];
    let lineNo = 0;
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < startLine) continue;
      // 继续读完整个文件以返回真实总行数，前端才能可靠停止触底加载。
      if (lines.length < limit) lines.push(previewLine(line));
    }

    const nextLine = startLine + lines.length;
    const hasMore = nextLine <= lineNo;
    res.json({
      path: toRemotePath(file, settings.workspaceRoot),
      size: info.size,
      mode: 'chunk',
      startLine,
      lines,
      totalLines: lineNo,
      nextLine: hasMore ? nextLine : null,
      hasMore,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
