import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { mkdir, open as openFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Request, Response } from 'express';
import { getToolSettings } from '../settings.js';
import { ensureOfficePdfPreview, isOfficeConvertiblePath } from '../files/officePreview.js';
import { mediaTypeFromPath, normalizeRemotePath, streamWorkspaceFile, toRemotePath, workspaceRoot } from '../files/workspace.js';
import { clampShareTtlSeconds, signFileShare, verifyFileShare } from './auth.js';
import { resolveIdentityFromAuthorizationHeader } from '../auth/resolve.js';
import { requireTenantScope } from '../auth/guards.js';

const SMALL_FILE_BYTES = 200 * 1024;
const MAX_RENDER_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1000;
const MAX_PREVIEW_LINE_CHARS = 12_000;
const DEFAULT_HEX_LIMIT = 4 * 1024;
const MAX_HEX_LIMIT = 64 * 1024;
const HEX_ROW_BYTES = 16;

export const filesApi = Router();

type ByteRange = { start: number; end: number };
type ByteRangeResult = ByteRange | 'invalid' | null;

function parentRemotePath(abs: string, configuredRoot: string): string | null {
  const root = workspaceRoot(configuredRoot);
  if (resolve(abs) === root) return null;
  return toRemotePath(dirname(abs), configuredRoot);
}

function canonicalRemotePath(abs: string, configuredRoot: string): string {
  const remotePath = toRemotePath(abs, configuredRoot);
  return remotePath === '.' ? '' : remotePath;
}

function rawFileUrl(path: string, expires: number, sig: string): string {
  const params = new URLSearchParams({ path, expires: String(expires), sig });
  return `/api/files/raw?${params.toString()}`;
}

function sharePageUrl(path: string, expires: number, sig: string): string {
  const params = new URLSearchParams({ path, expires: String(expires), sig });
  return `/share/file?${params.toString()}`;
}

function fileName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) || path || 'file';
}

async function requireFileAccess(req: Request, res: Response, absPath: string, configuredRoot: string): Promise<boolean> {
  const identity = await resolveIdentityFromAuthorizationHeader(req.headers.authorization);
  // 只有租户身份才能直接读工作区文件；系统管理员不能借着这条路径绕过审计去看任意租户的文件
  // (docs/multi-tenancy-design.md §4)。免身份的签名分享链接不受影响，走下面的签名校验分支。
  if (identity?.scope === 'tenant') return true;
  const path = canonicalRemotePath(absPath, configuredRoot);
  if (verifyFileShare(path, req.query.expires, req.query.sig)) return true;
  res.status(403).json({ error: '文件分享签名无效或已过期' });
  return false;
}

function previewLine(line: string): string {
  if (line.length <= MAX_PREVIEW_LINE_CHARS) return line;
  return `${line.slice(0, MAX_PREVIEW_LINE_CHARS)} ... [预览已截断 ${line.length - MAX_PREVIEW_LINE_CHARS} 个字符]`;
}

export function previewTextLines(text: string, options: { truncateLongLines?: boolean } = {}): string[] {
  const truncateLongLines = options.truncateLongLines !== false;
  return text.split(/\r?\n/).map((line) => (truncateLongLines ? previewLine(line) : line));
}

export function formatHexRows(buffer: Buffer, startOffset = 0) {
  const rows: Array<{ offset: number; hex: string; ascii: string }> = [];
  for (let index = 0; index < buffer.length; index += HEX_ROW_BYTES) {
    const slice = buffer.subarray(index, index + HEX_ROW_BYTES);
    const hex = Array.from(slice).map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const ascii = Array.from(slice).map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('');
    rows.push({ offset: startOffset + index, hex, ascii });
  }
  return rows;
}

export function parseByteRange(header: unknown, size: number): ByteRangeResult {
  if (typeof header !== 'string' || !header.trim()) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return 'invalid';

  const [, startText, endText] = match;
  if (!startText && !endText) return 'invalid';

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

filesApi.get('/info', requireTenantScope, async (_req, res) => {
  const settings = await getToolSettings();
  const root = workspaceRoot(settings.workspaceRoot);
  res.json({ workspaceRoot: root, rootPath: toRemotePath(root, settings.workspaceRoot) });
});

filesApi.get('/list', requireTenantScope, async (req, res) => {
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

filesApi.post('/upload', requireTenantScope, async (req, res) => {
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

filesApi.post('/share-link', requireTenantScope, async (req, res) => {
  try {
    const settings = await getToolSettings();
    const file = normalizeRemotePath(req.body?.path, settings.workspaceRoot);
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });

    const path = canonicalRemotePath(file, settings.workspaceRoot);
    const ttlSeconds = clampShareTtlSeconds(req.body?.ttlSeconds);
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = signFileShare(path, expires);
    res.status(201).json({
      path,
      expiresAt: new Date(expires * 1000).toISOString(),
      url: sharePageUrl(path, expires, sig),
      rawUrl: rawFileUrl(path, expires, sig),
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesApi.get('/preview', async (req, res) => {
  try {
    const settings = await getToolSettings();
    const file = normalizeRemotePath(req.query.path, settings.workspaceRoot);
    if (!(await requireFileAccess(req, res, file, settings.workspaceRoot))) return;
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

filesApi.get('/hex', async (req, res) => {
  try {
    const settings = await getToolSettings();
    const file = normalizeRemotePath(req.query.path, settings.workspaceRoot);
    if (!(await requireFileAccess(req, res, file, settings.workspaceRoot))) return;
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });

    const rawOffset = Number(req.query.offset ?? 0);
    const rawLimit = Number(req.query.limit ?? DEFAULT_HEX_LIMIT);
    const offset = Math.min(info.size, Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0));
    const limit = Math.min(MAX_HEX_LIMIT, Math.max(0, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_HEX_LIMIT));
    const readableBytes = Math.min(limit, Math.max(0, info.size - offset));
    const buffer = Buffer.alloc(readableBytes);
    let bytesRead = 0;
    if (readableBytes > 0) {
      const handle = await openFile(file, 'r');
      try {
        const result = await handle.read(buffer, 0, readableBytes, offset);
        bytesRead = result.bytesRead;
      } finally {
        await handle.close();
      }
    }

    const nextOffset = offset + bytesRead;
    const hasMore = nextOffset < info.size;
    res.json({
      path: toRemotePath(file, settings.workspaceRoot),
      size: info.size,
      offset,
      limit: bytesRead,
      rows: formatHexRows(buffer.subarray(0, bytesRead), offset),
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesApi.get('/pdf-preview', async (req, res) => {
  try {
    const settings = await getToolSettings();
    const file = normalizeRemotePath(req.query.path, settings.workspaceRoot);
    if (!(await requireFileAccess(req, res, file, settings.workspaceRoot))) return;
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });
    if (!isOfficeConvertiblePath(file)) return res.status(415).json({ error: '当前文件类型不支持 PDF 预览' });

    const remotePath = canonicalRemotePath(file, settings.workspaceRoot);
    const pdfPath = await ensureOfficePdfPreview({ file, remotePath, size: info.size, mtimeMs: info.mtimeMs });
    const pdfInfo = await stat(pdfPath);
    const range = parseByteRange(req.headers.range, pdfInfo.size);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${fileName(remotePath)}.pdf`)}`);

    if (range === 'invalid') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${pdfInfo.size}`);
      res.end();
      return;
    }
    if (range) {
      const contentLength = range.end - range.start + 1;
      res.status(206);
      res.setHeader('Content-Length', String(contentLength));
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${pdfInfo.size}`);
      streamWorkspaceFile(pdfPath, range).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(pdfInfo.size));
    streamWorkspaceFile(pdfPath).pipe(res);
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? 'Office 转 PDF 超时' : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

filesApi.get('/raw', async (req, res) => {
  try {
    const settings = await getToolSettings();
    const file = normalizeRemotePath(req.query.path, settings.workspaceRoot);
    if (!(await requireFileAccess(req, res, file, settings.workspaceRoot))) return;
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });

    const range = parseByteRange(req.headers.range, info.size);
    res.setHeader('Content-Type', mediaTypeFromPath(file));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName(toRemotePath(file, settings.workspaceRoot)))}`);
    }
    if (range === 'invalid') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${info.size}`);
      res.end();
      return;
    }
    if (range) {
      const contentLength = range.end - range.start + 1;
      res.status(206);
      res.setHeader('Content-Length', String(contentLength));
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
      streamWorkspaceFile(file, range).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(info.size));
    streamWorkspaceFile(file).pipe(res);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
