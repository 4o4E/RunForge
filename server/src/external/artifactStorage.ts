import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getSystemToolSettings } from '../settings.js';
import { isWithin } from '../tools/policy.js';

export interface ExternalArtifactStorage {
  write(storageKey: string, content: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

/** 同目录临时文件 + rename，保证读取方不会看到半写入内容。 */
export async function writeFileAtomically(target: string, content: Buffer, stableTemp?: string): Promise<void> {
  const temp = stableTemp ?? `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    if (stableTemp) await rm(temp, { force: true });
    await writeFile(temp, content, { flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 上传暂存区禁止覆盖既有 storage key；hard link 在目标名上提供原子排他创建。 */
async function writeNewFileAtomically(target: string, content: Buffer): Promise<void> {
  const temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temp, content, { flag: 'wx' });
    await link(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** 外部附件先进入独立受控存储，不能把调用方文件名当作宿主机路径。 */
export class FileExternalArtifactStorage implements ExternalArtifactStorage {
  constructor(
    private readonly configuredRoot?: string,
  ) {}

  private async root(): Promise<string> {
    if (this.configuredRoot) return resolve(this.configuredRoot);
    const settings = await getSystemToolSettings();
    return resolve(settings.workspaceRoot, '.runforge', 'external-artifacts');
  }

  private path(root: string, storageKey: string): string {
    const target = resolve(root, storageKey);
    if (!isWithin(root, target)) throw new Error('artifact storage key 越界');
    return target;
  }

  async write(storageKey: string, content: Buffer): Promise<void> {
    const root = await this.root();
    const target = this.path(root, storageKey);
    await writeNewFileAtomically(target, content);
  }

  async read(storageKey: string): Promise<Buffer> {
    const root = await this.root();
    return readFile(this.path(root, storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    const root = await this.root();
    return rm(this.path(root, storageKey), { force: true });
  }

  /**
   * 单实例启动前按数据库记录回收孤立文件。上传采用“文件先落盘、数据库后提交”，
   * 因而进程恰好在两者之间退出时可能残留无归属文件；监听请求前对账不会误删并发上传。
   */
  async reconcile(referencedKeys: ReadonlySet<string>): Promise<number> {
    const root = await this.root();
    let callerEntries;
    try {
      callerEntries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }

    let removed = 0;
    for (const callerEntry of callerEntries) {
      const callerPath = this.path(root, callerEntry.name);
      if (!callerEntry.isDirectory()) {
        await rm(callerPath, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      const artifactEntries = await readdir(callerPath, { withFileTypes: true });
      for (const artifactEntry of artifactEntries) {
        const storageKey = `${callerEntry.name}/${artifactEntry.name}`;
        if (artifactEntry.isFile() && referencedKeys.has(storageKey)) continue;
        await rm(this.path(root, storageKey), { recursive: true, force: true });
        removed += 1;
      }
      await rmdir(callerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
      });
    }
    return removed;
  }
}

export const externalArtifactStorage = new FileExternalArtifactStorage();
