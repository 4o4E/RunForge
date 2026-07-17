import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config.js';

const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'odt',
  'ppt',
  'pptx',
  'odp',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'ods',
]);

const inflight = new Map<string, Promise<string>>();

export function isOfficeConvertiblePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return OFFICE_EXTENSIONS.has(ext);
}

export function officePdfCacheKey(input: { remotePath: string; size: number; mtimeMs: number; converterUrl: string; cacheVersion?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, ...input, cacheVersion: input.cacheVersion ?? '' }))
    .digest('hex');
}

function converterUrl(): string {
  return config.preview.officeConverterUrl.trim().replace(/\/+$/, '');
}

function cacheRoot(): string {
  return config.preview.officeCacheDir.trim() || join(tmpdir(), 'runforge-office-previews');
}

async function convertWithLibreOffice(file: string, signal: AbortSignal): Promise<Buffer> {
  const baseUrl = converterUrl();
  if (!baseUrl) throw new Error('缺少 OFFICE_PREVIEW_CONVERTER_URL，无法生成 Office PDF 预览');

  const body = new FormData();
  const bytes = await readFile(file);
  body.append('files', new Blob([bytes]), basename(file));

  const res = await fetch(`${baseUrl}/forms/libreoffice/convert`, {
    method: 'POST',
    body,
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Office 转 PDF 失败：${res.status} ${detail || res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function ensureOfficePdfPreview(input: { file: string; remotePath: string; size: number; mtimeMs: number }): Promise<string> {
  if (!isOfficeConvertiblePath(input.file)) throw new Error('当前文件类型不支持 Office PDF 预览');

  const key = officePdfCacheKey({
    remotePath: input.remotePath,
    size: input.size,
    mtimeMs: input.mtimeMs,
    converterUrl: converterUrl(),
    cacheVersion: config.preview.officeCacheVersion,
  });
  const dir = join(cacheRoot(), key);
  const pdfPath = join(dir, 'preview.pdf');

  try {
    const cached = await stat(pdfPath);
    if (cached.isFile() && cached.size > 0) return pdfPath;
  } catch {
    // 缓存缺失时继续生成。
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    await mkdir(dir, { recursive: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, config.preview.officeTimeoutMs));
    try {
      const pdf = await convertWithLibreOffice(input.file, controller.signal);
      const tmpPath = join(dir, `preview.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tmpPath, pdf);
      await rename(tmpPath, pdfPath);
      return pdfPath;
    } finally {
      clearTimeout(timeout);
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}
