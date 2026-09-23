import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** 托管目录以内容版本命名并在准备完成后一次性发布，正在运行的会话不会读到半成品。 */
export async function ensureManagedDirectory(
  target: string,
  materialize: (staging: string) => Promise<void>,
): Promise<void> {
  let existing;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (!existing.isDirectory() || await realpath(target) !== resolve(target)) {
      throw new Error(`托管资源版本不是普通目录：${target}`);
    }
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  if (await realpath(dirname(target)) !== resolve(dirname(target))) {
    throw new Error(`托管资源上级目录经过符号链接：${target}`);
  }
  const staging = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await materialize(staging);
    try {
      await rename(staging, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** 会话只持有相对链接；目录树整体移动时，空间资源与会话入口仍保持对应。 */
export async function ensureManagedLink(source: string, target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink() && await realpath(target) === await realpath(source)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== resolve(parent)) {
    throw new Error(`托管资源入口上级目录经过符号链接：${target}`);
  }
  const relativeTarget = relative(parent, resolve(source));
  if (!relativeTarget || isAbsolute(relativeTarget)) throw new Error(`无法创建托管资源相对链接：${source}`);
  const staging = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const backup = `${target}.old-${process.pid}-${randomUUID()}`;
  let movedExisting = false;
  try {
    await symlink(relativeTarget, staging, 'dir');
    try {
      await rename(target, backup);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staging, target);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting && !existsSync(target)) await rename(backup, target);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (existsSync(target)) await rm(backup, { recursive: true, force: true });
  }
}
