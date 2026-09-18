import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open as openFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Request, Response } from 'express';
import { resolveThreadWorkspaceRoot, resolveWorkspaceRoot } from '../files/workspaceRoot.js';
import { threadWorkspaceAccess, ThreadWorkspaceAccessError } from '../files/threadWorkspace.js';
import { ensureOfficePdfPreview, isOfficeConvertiblePath } from '../files/officePreview.js';
import { mediaTypeFromPath, normalizeRemotePath, streamWorkspaceFile, toRemotePath, workspaceRoot } from '../files/workspace.js';
import { clampShareTtlSeconds, signFileShare, verifyFileShare } from './auth.js';
import { resolveIdentityFromAuthorizationHeader } from '../auth/resolve.js';
import { requireTenantScope } from '../auth/guards.js';
import { getSystemToolSettings } from '../settings.js';

const SMALL_FILE_BYTES = 200 * 1024;
const MAX_RENDER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1000;
const MAX_PREVIEW_LINE_CHARS = 12_000;
const DEFAULT_HEX_LIMIT = 4 * 1024;
const MAX_HEX_LIMIT = 64 * 1024;
const HEX_ROW_BYTES = 16;

export const filesApi = Router();

type ByteRange = { start: number; end: number };
type ByteRangeResult = ByteRange | 'invalid' | null;

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function textVersion(info: { size: number; mtimeMs: number }, content: Buffer | string) {
  return { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(content) };
}

function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function parentRemotePath(abs: string, configuredRoot: string): string | null {
  const root = workspaceRoot(configuredRoot);
  if (resolve(abs) === root) return null;
  return toRemotePath(dirname(abs), configuredRoot);
}

function canonicalRemotePath(abs: string, configuredRoot: string): string {
  const remotePath = toRemotePath(abs, configuredRoot);
  return remotePath === '.' ? '' : remotePath;
}

function rawFileUrl(path: string, tenantId: string, userId: string, expires: number, sig: string, threadId?: string | null): string {
  const params = new URLSearchParams({ path, tenant: tenantId, user: userId, expires: String(expires), sig });
  if (threadId) params.set('threadId', threadId);
  return `/api/files/raw?${params.toString()}`;
}

function sharePageUrl(path: string, tenantId: string, userId: string, expires: number, sig: string, threadId?: string | null): string {
  const params = new URLSearchParams({ path, tenant: tenantId, user: userId, expires: String(expires), sig });
  if (threadId) params.set('threadId', threadId);
  return `/share/file?${params.toString()}`;
}

function fileName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) || path || 'file';
}

type FileAccessMode = 'read' | 'write';

interface FileAccess {
  tenantId: string;
  userId: string;
  threadId: string | null;
  workspaceRoot: string;
  workspaceKey: string;
  file: string;
}

function requestedThreadId(req: Request): string | null {
  const raw = req.method === 'GET' ? req.query.threadId : req.body?.threadId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function sendFileError(res: Response, error: unknown): void {
  if (error instanceof ThreadWorkspaceAccessError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(400).json({ error: (error as Error).message });
}

/** 已登录请求先按可见空间和 thread 归属授权，再计算 workspace；签名分享没有身份，
 *  因此 tenant/user/threadId 都必须进入 HMAC。带 threadId 的分享只表示非 default
 *  thread workspace，default 空间仍生成历史用户级链接。 */
async function resolveFileAccess(
  req: Request,
  res: Response,
  requestedPath: unknown,
  mode: FileAccessMode = 'read',
): Promise<FileAccess | null> {
  const signedRequest = req.method === 'GET'
    && typeof req.query.sig === 'string'
    && typeof req.query.expires === 'string';
  const identity = signedRequest ? null : await resolveIdentityFromAuthorizationHeader(req.headers.authorization);
  if (identity?.scope === 'tenant') {
    try {
      // 系统管理员不能借这条普通文件路径绕过审计；这里只有租户身份可以进入。
      const workspace = await threadWorkspaceAccess.resolveForWeb(identity, requestedThreadId(req), mode);
      await mkdir(workspace.root, { recursive: true });
      return {
        tenantId: identity.tenantId,
        userId: identity.userId,
        threadId: workspace.threadId,
        workspaceRoot: workspace.root,
        workspaceKey: workspace.kind === 'thread' ? `thread:${workspace.threadId}` : `user:${identity.userId}`,
        file: normalizeRemotePath(requestedPath, workspace.root),
      };
    } catch (error) {
      sendFileError(res, error);
      return null;
    }
  }
  const tenantId = typeof req.query.tenant === 'string' && req.query.tenant.trim() ? req.query.tenant.trim() : 'default';
  const userId = typeof req.query.user === 'string' && req.query.user.trim() ? req.query.user.trim() : '';
  const threadId = requestedThreadId(req);
  if (!userId) {
    res.status(403).json({ error: '文件分享缺少用户身份' });
    return null;
  }
  const { workspaceRoot: baseRoot } = await getSystemToolSettings();
  const root = threadId
    ? resolveThreadWorkspaceRoot(threadId, baseRoot)
    : resolveWorkspaceRoot({ tenantId, userId }, baseRoot);
  const file = normalizeRemotePath(requestedPath, root);
  const path = canonicalRemotePath(file, root);
  if (verifyFileShare(path, tenantId, userId, req.query.expires, req.query.sig, undefined, threadId)) {
    return {
      tenantId,
      userId,
      threadId,
      workspaceRoot: root,
      workspaceKey: threadId ? `thread:${threadId}` : `user:${userId}`,
      file,
    };
  }
  res.status(403).json({ error: '文件分享签名无效或已过期' });
  return null;
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

filesApi.get('/info', requireTenantScope, async (req, res) => {
  const access = await resolveFileAccess(req, res, '.');
  if (!access) return;
  res.json({ workspaceRoot: access.workspaceRoot, rootPath: '.' });
});

filesApi.get('/list', requireTenantScope, async (req, res) => {
  try {
    const access = await resolveFileAccess(req, res, req.query.path);
    if (!access) return;
    const dir = access.file;
    const info = await stat(dir);
    if (!info.isDirectory()) return res.status(400).json({ error: 'path 不是目录' });

    const entries = await Promise.all(
      (await readdir(dir)).map(async (name) => {
        const abs = join(dir, name);
        const s = await stat(abs);
        return {
          name,
          path: toRemotePath(abs, access.workspaceRoot),
          type: s.isDirectory() ? 'dir' : 'file',
          size: s.size,
          updatedAt: s.mtime.toISOString(),
        };
      }),
    );

    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: toRemotePath(dir, access.workspaceRoot), parent: parentRemotePath(dir, access.workspaceRoot), entries });
  } catch (err) {
    sendFileError(res, err);
  }
});

filesApi.post('/upload', requireTenantScope, async (req, res) => {
  try {
    const access = await resolveFileAccess(req, res, req.body?.path, 'write');
    if (!access) return;
    const targetPath = access.file;
    const contentBase64 = String(req.body?.contentBase64 ?? '');
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 为必填' });

    const content = Buffer.from(contentBase64, 'base64');
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
    res.status(201).json({ path: toRemotePath(targetPath, access.workspaceRoot), size: content.length });
  } catch (err) {
    sendFileError(res, err);
  }
});

filesApi.get('/content', requireTenantScope, async (req, res) => {
  try {
    const access = await resolveFileAccess(req, res, req.query.path);
    if (!access) return;
    const { file, workspaceRoot: root } = access;
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });
    if (info.size > MAX_TEXT_FILE_BYTES) return res.status(413).json({ error: `文件超过文本编辑上限 ${MAX_TEXT_FILE_BYTES} 字节` });

    const buffer = await readFile(file);
    if (isLikelyBinary(buffer)) return res.status(415).json({ error: '二进制文件不支持文本编辑' });
    const content = buffer.toString('utf8');
    res.json({ path: toRemotePath(file, root), content, version: textVersion(info, buffer) });
  } catch (err) {
    sendFileError(res, err);
  }
});

filesApi.put('/content', requireTenantScope, async (req, res) => {
  let tempPath = '';
  try {
    const access = await resolveFileAccess(req, res, req.body?.path, 'write');
    if (!access) return;
    const { file, workspaceRoot: root } = access;
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    const baseSha256 = typeof req.body?.baseSha256 === 'string' ? req.body.baseSha256 : '';
    const force = req.body?.force === true;
    if (content == null) return res.status(400).json({ error: 'content 为必填' });
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) return res.status(413).json({ error: `文件超过编辑上限 ${MAX_TEXT_FILE_BYTES} 字节` });

    const currentInfo = await stat(file);
    if (!currentInfo.isFile()) return res.status(400).json({ error: 'path 不是文件' });
    const currentBuffer = await readFile(file);
    if (isLikelyBinary(currentBuffer)) return res.status(415).json({ error: '二进制文件不支持文本编辑' });
    const currentVersion = textVersion(currentInfo, currentBuffer);
    if (!force && baseSha256 && baseSha256 !== currentVersion.sha256) {
      return res.status(409).json({ error: '文件已被其他进程修改，请重新加载后再保存', currentVersion });
    }

    // 写到同目录临时文件再 rename，避免保存中断时留下半截目标文件。
    tempPath = join(dirname(file), `.${fileName(file)}.${randomUUID()}.tmp`);
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, file);
    tempPath = '';
    const nextInfo = await stat(file);
    res.json({ path: toRemotePath(file, root), size: nextInfo.size, version: textVersion(nextInfo, Buffer.from(content, 'utf8')) });
  } catch (err) {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
    sendFileError(res, err);
  }
});

filesApi.post('/share-link', requireTenantScope, async (req, res) => {
  try {
    const access = await resolveFileAccess(req, res, req.body?.path);
    if (!access) return;
    const { file, workspaceRoot: root } = access;
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });

    const path = canonicalRemotePath(file, root);
    const ttlSeconds = clampShareTtlSeconds(req.body?.ttlSeconds);
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = signFileShare(path, access.tenantId, access.userId, expires, access.threadId);
    res.status(201).json({
      path,
      expiresAt: new Date(expires * 1000).toISOString(),
      url: sharePageUrl(path, access.tenantId, access.userId, expires, sig, access.threadId),
      rawUrl: rawFileUrl(path, access.tenantId, access.userId, expires, sig, access.threadId),
    });
  } catch (err) {
    sendFileError(res, err);
  }
});

filesApi.get('/preview', async (req, res) => {
  try {
    const access = await resolveFileAccess(req, res, req.query.path);
    if (!access) return;
    const { file, workspaceRoot: root } = access;
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
        path: toRemotePath(file, root),
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
      path: toRemotePath(file, root),
      size: info.size,
      mode: 'chunk',
      startLine,
      lines,
      totalLines: lineNo,
      nextLine: hasMore ? nextLine : null,
      hasMore,
    });
  } catch (err) {
    sendFileError(res, err);
  }
});

filesApi.get('/hex', async (req, res) => {
  try {
    const access = await resolveFileAccess(req, res, req.query.path);
    if (!access) return;
    const { file } = access;
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
      path: toRemotePath(file, access.workspaceRoot),
      size: info.size,
      offset,
      limit: bytesRead,
      rows: formatHexRows(buffer.subarray(0, bytesRead), offset),
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
    });
  } catch (err) {
    sendFileError(res, err);
  }
});

filesApi.get('/pdf-preview', async (req, res) => {
  try {
    const access = await resolveFileAccess(req, res, req.query.path);
    if (!access) return;
    const { file, workspaceRoot: root, tenantId, workspaceKey } = access;
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });
    if (!isOfficeConvertiblePath(file)) return res.status(415).json({ error: '当前文件类型不支持 PDF 预览' });

    const remotePath = canonicalRemotePath(file, root);
    const pdfPath = await ensureOfficePdfPreview({ tenantId, workspaceKey, file, remotePath, size: info.size, mtimeMs: info.mtimeMs });
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
    const access = await resolveFileAccess(req, res, req.query.path);
    if (!access) return;
    const { file, workspaceRoot: root } = access;
    const info = await stat(file);
    if (!info.isFile()) return res.status(400).json({ error: 'path 不是文件' });

    const range = parseByteRange(req.headers.range, info.size);
    res.setHeader('Content-Type', mediaTypeFromPath(file));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName(toRemotePath(file, root)))}`);
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
    sendFileError(res, err);
  }
});
