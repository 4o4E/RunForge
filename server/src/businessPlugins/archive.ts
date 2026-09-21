import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar, type ReadEntry } from 'tar';
import yauzl, { type Entry as ZipEntry } from 'yauzl';
import { BusinessPluginError } from './errors.js';

export type BusinessPluginArchiveFormat = 'zip' | 'tgz';

// Linux amd64 FFmpeg 发布包约 143 MiB，插件外层归档和解压后的两个命令
// 需要高于旧的通用业务包限制；仍保留单文件和总条目上限，避免把归档限制放大为无限制。
export const BUSINESS_PLUGIN_MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRY_BYTES = 300 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_PATH_DEPTH = 32;
const MANIFEST_FILE = 'runforge.plugin.yaml';

interface ArchiveLimits {
  entries: number;
  bytes: number;
}

function archiveError(message: string): BusinessPluginError {
  return new BusinessPluginError('BUSINESS_PLUGIN_ARCHIVE_INVALID', message);
}

function archiveTooLarge(message: string): BusinessPluginError {
  return new BusinessPluginError('BUSINESS_PLUGIN_ARCHIVE_TOO_LARGE', message);
}

export function normalizedArchivePath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/$/, '');
  if (!path || path === '.') return '';
  const parts = path.split('/');
  if (
    path.startsWith('/')
    || /^[A-Za-z]:\//.test(path)
    || parts.some((part) => !part || part === '..')
    || parts.length > MAX_PATH_DEPTH
    || /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw archiveError(`压缩包包含非法路径：${value}`);
  }
  return path;
}

function countEntry(limits: ArchiveLimits, size: number, path: string): void {
  if (!Number.isSafeInteger(size) || size < 0) throw archiveError(`压缩包条目大小无效：${path}`);
  limits.entries += 1;
  limits.bytes += size;
  if (limits.entries > MAX_ENTRIES) throw archiveTooLarge(`压缩包文件数量超过 ${MAX_ENTRIES}`);
  if (size > MAX_ENTRY_BYTES) throw archiveTooLarge(`压缩包单个文件超过 ${MAX_ENTRY_BYTES / 1024 / 1024} MiB：${path}`);
  if (limits.bytes > MAX_EXTRACTED_BYTES) {
    throw archiveTooLarge(`压缩包解压后总大小超过 ${MAX_EXTRACTED_BYTES / 1024 / 1024} MiB`);
  }
}

function zipEntryType(externalFileAttributes: number): number {
  return ((externalFileAttributes >>> 16) & 0xffff) & 0o170000;
}

function validateZipEntry(entry: ZipEntry, limits: ArchiveLimits): void {
  if (entry.fileName.startsWith('__MACOSX/')) return;
  const path = normalizedArchivePath(entry.fileName);
  if (!path) return;
  const type = zipEntryType(entry.externalFileAttributes);
  if (type === 0o120000) throw archiveError(`ZIP 不允许符号链接：${path}`);
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
    throw archiveError(`ZIP 只允许普通文件和目录：${path}`);
  }
  countEntry(limits, entry.fileName.endsWith('/') ? 0 : entry.uncompressedSize, path);
}

async function inspectZipArchive(archivePath: string): Promise<void> {
  const limits: ArchiveLimits = { entries: 0, bytes: 0 };
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? archiveError('无法打开 ZIP 压缩包'));
        return;
      }
      let failed = false;
      zip.once('error', (error) => {
        failed = true;
        reject(error);
      });
      zip.once('end', () => {
        if (!failed) resolve();
      });
      zip.on('entry', (entry) => {
        try {
          validateZipEntry(entry, limits);
          zip.readEntry();
        } catch (error) {
          failed = true;
          zip.close();
          reject(error);
        }
      });
      zip.readEntry();
    });
  });
}

async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
  await inspectZipArchive(archivePath);
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? archiveError('无法打开 ZIP 压缩包'));
        return;
      }
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.once('error', fail);
      zip.once('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on('entry', (entry) => {
        void (async () => {
          if (entry.fileName.startsWith('__MACOSX/')) return;
          const path = normalizedArchivePath(entry.fileName);
          if (!path) return;
          const target = join(destination, path);
          const type = zipEntryType(entry.externalFileAttributes);
          const directory = entry.fileName.endsWith('/') || type === 0o040000;
          if (directory) {
            await mkdir(target, { recursive: true });
            return;
          }
          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((streamResolve, streamReject) => {
            zip.openReadStream(entry, (streamError, readStream) => {
              if (streamError || !readStream) streamReject(streamError ?? archiveError(`无法读取 ZIP 条目：${path}`));
              else streamResolve(readStream);
            });
          });
          const archivedMode = (entry.externalFileAttributes >>> 16) & 0o777;
          await pipeline(stream, createWriteStream(target, {
            flags: 'wx',
            mode: archivedMode || 0o644,
          }));
        })().then(() => zip.readEntry(), fail);
      });
      zip.readEntry();
    });
  });
}

function validateTarEntry(pathValue: string, entry: ReadEntry, limits: ArchiveLimits): boolean {
  if (entry.meta) return true;
  const path = normalizedArchivePath(pathValue);
  if (!path) return true;
  if (!['File', 'OldFile', 'ContiguousFile', 'Directory'].includes(entry.type)) {
    throw archiveError(`TGZ 只允许普通文件和目录：${path}`);
  }
  countEntry(limits, entry.type === 'Directory' ? 0 : entry.size, path);
  return true;
}

async function extractTgzArchive(archivePath: string, destination: string): Promise<void> {
  const limits: ArchiveLimits = { entries: 0, bytes: 0 };
  let validationError: BusinessPluginError | null = null;
  await extractTar({
    file: archivePath,
    cwd: destination,
    gzip: true,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    maxDepth: MAX_PATH_DEPTH,
    maxDecompressionRatio: 100,
    filter: (path, entry) => {
      if (validationError) return false;
      try {
        return validateTarEntry(path, entry as ReadEntry, limits);
      } catch (error) {
        validationError = error instanceof BusinessPluginError
          ? error
          : archiveError((error as Error).message);
        return false;
      }
    },
  });
  if (validationError) throw validationError;
}

async function validateExtractedTree(root: string): Promise<void> {
  const limits: ArchiveLimits = { entries: 0, bytes: 0 };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        countEntry(limits, 0, path);
        await chmod(path, 0o755);
        await walk(path);
      } else if (entry.isFile()) {
        const stats = await lstat(path);
        countEntry(limits, stats.size, path);
        const mode = stats.mode & 0o111 ? 0o755 : 0o644;
        await chmod(path, mode);
      } else {
        throw archiveError(`压缩包解压后包含特殊文件：${path}`);
      }
    }
  };
  await walk(root);
}

async function locatePluginRoot(extractedRoot: string): Promise<string> {
  const entries = await readdir(extractedRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST_FILE)) return extractedRoot;
  if (entries.length !== 1 || !entries[0]?.isDirectory()) {
    throw archiveError(`压缩包根目录必须直接包含 ${MANIFEST_FILE}，或只包含一个插件目录`);
  }
  const pluginRoot = join(extractedRoot, entries[0].name);
  const pluginEntries = await readdir(pluginRoot, { withFileTypes: true });
  if (!pluginEntries.some((entry) => entry.isFile() && entry.name === MANIFEST_FILE)) {
    throw archiveError(`压缩包中的插件目录缺少 ${MANIFEST_FILE}`);
  }
  return pluginRoot;
}

export async function extractBusinessPluginArchive(
  archive: Buffer,
  format: BusinessPluginArchiveFormat,
  parentDirectory: string,
): Promise<{ temporaryRoot: string; pluginRoot: string }> {
  if (!archive.length) throw archiveError('压缩包内容为空');
  if (archive.length > BUSINESS_PLUGIN_MAX_ARCHIVE_BYTES) {
    throw archiveTooLarge(`压缩包大小超过 ${BUSINESS_PLUGIN_MAX_ARCHIVE_BYTES / 1024 / 1024} MiB`);
  }
  await mkdir(parentDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(join(parentDirectory, '.runforge-archive-'));
  const archivePath = join(temporaryRoot, format === 'zip' ? 'plugin.zip' : 'plugin.tgz');
  const extractedRoot = join(temporaryRoot, 'extracted');
  try {
    await mkdir(extractedRoot);
    await writeFile(archivePath, archive, { mode: 0o600 });
    if (format === 'zip') await extractZipArchive(archivePath, extractedRoot);
    else await extractTgzArchive(archivePath, extractedRoot);
    await validateExtractedTree(extractedRoot);
    return { temporaryRoot, pluginRoot: await locatePluginRoot(extractedRoot) };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (error instanceof BusinessPluginError) throw error;
    throw archiveError(`无法解压业务插件：${(error as Error).message}`);
  }
}
