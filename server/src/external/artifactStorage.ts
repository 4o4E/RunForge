import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { isWithin } from '../tools/policy.js';

export const MAX_EXTERNAL_ARTIFACT_BYTES = 25 * 1024 * 1024;

export interface ExternalArtifactStorage {
  write(storageKey: string, content: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

/** 外部附件先进入独立受控存储，不能把调用方文件名当作宿主机路径。 */
export class FileExternalArtifactStorage implements ExternalArtifactStorage {
  constructor(
    private readonly root = resolve(config.tools.workspaceRoot, '.runforge', 'external-artifacts'),
  ) {}

  private path(storageKey: string): string {
    const target = resolve(this.root, storageKey);
    if (!isWithin(this.root, target)) throw new Error('artifact storage key 越界');
    return target;
  }

  async write(storageKey: string, content: Buffer): Promise<void> {
    const target = this.path(storageKey);
    const temp = `${target}.${randomUUID()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(temp, content, { flag: 'wx' });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  read(storageKey: string): Promise<Buffer> {
    return readFile(this.path(storageKey));
  }

  remove(storageKey: string): Promise<void> {
    return rm(this.path(storageKey), { force: true });
  }

  /**
   * 单实例启动前按数据库记录回收孤立文件。上传采用“文件先落盘、数据库后提交”，
   * 因而进程恰好在两者之间退出时可能残留无归属文件；监听请求前对账不会误删并发上传。
   */
  async reconcile(referencedKeys: ReadonlySet<string>): Promise<number> {
    let callerEntries;
    try {
      callerEntries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }

    let removed = 0;
    for (const callerEntry of callerEntries) {
      const callerPath = this.path(callerEntry.name);
      if (!callerEntry.isDirectory()) {
        await rm(callerPath, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      const artifactEntries = await readdir(callerPath, { withFileTypes: true });
      for (const artifactEntry of artifactEntries) {
        const storageKey = `${callerEntry.name}/${artifactEntry.name}`;
        if (artifactEntry.isFile() && referencedKeys.has(storageKey)) continue;
        await rm(this.path(storageKey), { recursive: true, force: true });
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
