import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { resolveThreadWorkspaceRoot } from '../files/workspaceRoot.js';
import { verifySpaceRuntimeLock } from '../plugins/lock.js';
import type { SpaceRuntimeLock } from '../plugins/types.js';

type LockedPlugin = { contentHash: string };
type Candidate = { threadId: string; pluginId: string; target: string; snapshot: string };

const execFileAsync = promisify(execFile);
const apply = process.argv.slice(2).includes('--apply');
if (process.argv.slice(2).some((arg) => arg !== '--apply')) {
  throw new Error('用法：migrateLegacyPluginLinks [--apply]；默认只预览');
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function allocatedBytes(path: string): Promise<number> {
  const { stdout } = await execFileAsync('du', ['-sB1', '--', path], { maxBuffer: 1024 * 1024 });
  const value = Number(stdout.split('\t')[0]);
  if (!Number.isSafeInteger(value)) throw new Error(`无法读取目录占用：${path}`);
  return value;
}

function formatBytes(value: number): string {
  return `${value.toLocaleString('zh-CN')} 字节（${(value / 1024 ** 3).toFixed(3)} GiB）`;
}

async function totalStorage(workspaceRoot: string, pluginRoots: readonly string[]): Promise<{ workspace: number; plugins: number; total: number }> {
  const workspace = await allocatedBytes(workspaceRoot);
  const plugins = (await Promise.all(pluginRoots.map(allocatedBytes))).reduce((sum, value) => sum + value, 0);
  return { workspace, plugins, total: workspace + plugins };
}

/** 按每个 thread 最近一次使用某插件的运行锁选择版本，不读取大体积插件文件。 */
async function lockedPlugins(): Promise<Map<string, LockedPlugin>> {
  const result = await pool.query<{ thread_id: string; plugin_lock: unknown }>(
    `SELECT thread_id, plugin_lock FROM runs
     WHERE plugin_lock IS NOT NULL
     ORDER BY thread_id, created_at DESC, id DESC`,
  );
  const locks = new Map<string, LockedPlugin>();
  for (const row of result.rows) {
    let lock: SpaceRuntimeLock;
    try {
      lock = verifySpaceRuntimeLock(row.plugin_lock as SpaceRuntimeLock);
    } catch {
      continue;
    }
    for (const plugin of lock.plugins) {
      if (!plugin.id.startsWith('business.')) continue;
      const id = plugin.id.slice('business.'.length);
      const key = `${row.thread_id}\0${id}`;
      if (!locks.has(key)) locks.set(key, { contentHash: plugin.contentHash });
    }
  }
  return locks;
}

async function snapshotFor(
  pluginRoots: readonly string[], tenantId: string, pluginId: string, hash: string,
): Promise<string | null> {
  for (const root of pluginRoots) {
    const tenantRoot = resolve(root, tenantId);
    const snapshot = resolve(tenantRoot, '.runforge-snapshots', pluginId, hash, 'plugin');
    if (!within(root, tenantRoot) || !within(tenantRoot, snapshot) || !await directoryExists(snapshot)) continue;
    const [tenantCanonical, snapshotCanonical] = await Promise.all([realpath(tenantRoot), realpath(snapshot)]);
    if (within(tenantCanonical, snapshotCanonical)) return snapshotCanonical;
  }
  return null;
}

/** 用相对链接替换已由运行锁指向共享快照的旧副本；链接校验完成后才清理旧目录。 */
async function replaceWithLink(candidate: Candidate, workspaceRoot: string): Promise<void> {
  if (!within(workspaceRoot, candidate.target)) throw new Error(`迁移目标超出工作区：${candidate.target}`);
  const parent = dirname(candidate.target);
  const linkValue = relative(parent, candidate.snapshot);
  if (!linkValue || isAbsolute(linkValue)) throw new Error(`无法创建相对链接：${candidate.target}`);
  const staging = `${candidate.target}.link-${randomUUID()}`;
  const backup = `${candidate.target}.backup-${randomUUID()}`;
  if (!within(workspaceRoot, staging) || !within(workspaceRoot, backup)) throw new Error('迁移临时路径超出工作区');
  let needsRollback = false;
  try {
    await symlink(linkValue, staging, 'dir');
    await rename(candidate.target, backup);
    needsRollback = true;
    await rename(staging, candidate.target);
    if (await realpath(candidate.target) !== await realpath(candidate.snapshot)) {
      throw new Error(`链接目标校验失败：${candidate.target}`);
    }
    needsRollback = false;
    await rm(backup, { recursive: true });
  } catch (error) {
    if (needsRollback) {
      await rm(candidate.target, { force: true });
      await rename(backup, candidate.target);
    }
    throw error;
  } finally {
    await rm(staging, { force: true });
  }
}

async function main(): Promise<void> {
  const workspaceRoot = await realpath(config.tools.workspaceRoot);
  const pluginRoots = await Promise.all(config.businessPlugins.roots.map((root) => realpath(root)));
  for (const root of pluginRoots) {
    if (within(workspaceRoot, root) || within(root, workspaceRoot)) {
      throw new Error(`工作区与插件根目录重叠，无法计算不重复的总占用：${root}`);
    }
  }
  const before = await totalStorage(workspaceRoot, pluginRoots);
  console.log(`迁移前：工作区 ${formatBytes(before.workspace)}；插件库 ${formatBytes(before.plugins)}；总计 ${formatBytes(before.total)}`);

  const [threads, locks] = await Promise.all([
    prisma.threads.findMany({
      select: { id: true, tenant_id: true, space_id: true, executing_run_id: true },
      orderBy: [{ space_id: 'asc' }, { id: 'asc' }],
    }),
    lockedPlugins(),
  ]);
  const candidates: Candidate[] = [];
  let alreadyLinked = 0;
  let skipped = 0;
  let activeThreads = 0;
  for (const thread of threads) {
    if (thread.executing_run_id) {
      activeThreads += 1;
      continue;
    }
    const roots = [
      resolveThreadWorkspaceRoot(thread.space_id, thread.id, workspaceRoot),
      resolve(workspaceRoot, thread.id),
    ];
    for (const threadRoot of roots) {
      if (!within(workspaceRoot, threadRoot) || !await directoryExists(threadRoot)) continue;
      const pluginDir = join(threadRoot, 'plugins');
      if (!await directoryExists(pluginDir)) continue;
      for (const entry of await readdir(pluginDir, { withFileTypes: true })) {
        const target = join(pluginDir, entry.name);
        if (entry.isSymbolicLink()) {
          alreadyLinked += 1;
          continue;
        }
        if (!entry.isDirectory()) continue;
        try {
          if (!within(workspaceRoot, await realpath(target))) throw new Error('旧目录真实路径超出工作区');
          const lock = locks.get(`${thread.id}\0${entry.name}`);
          if (!lock) throw new Error('运行记录中没有该插件的版本锁');
          const snapshot = await snapshotFor(pluginRoots, thread.tenant_id, entry.name, lock.contentHash);
          if (!snapshot) throw new Error('同租户没有该版本的共享快照');
          const manifestPath = join(target, 'runforge.plugin.yaml');
          const snapshotManifestPath = join(snapshot, 'runforge.plugin.yaml');
          const [manifest, snapshotManifest] = await Promise.all([readFile(manifestPath), readFile(snapshotManifestPath)]);
          if (!manifest.equals(snapshotManifest)) {
            throw new Error('旧目录与共享快照的插件声明不同');
          }
          candidates.push({ threadId: thread.id, pluginId: entry.name, target, snapshot });
        } catch (error) {
          skipped += 1;
          console.warn(`跳过 ${target}：${(error as Error).message}`);
        }
      }
    }
  }
  console.log(`可转换 ${candidates.length} 个旧插件副本；已是链接 ${alreadyLinked} 个；跳过 ${skipped} 个；执行中会话 ${activeThreads} 个。`);
  if (!apply) {
    console.log('当前为预览；停止 RunForge 后使用 --apply 执行迁移。');
    return;
  }

  for (const candidate of candidates) {
    await replaceWithLink(candidate, workspaceRoot);
    if (isAbsolute(await readlink(candidate.target))) throw new Error(`迁移后链接不是相对路径：${candidate.target}`);
    console.log(`已转换 ${candidate.threadId}/${candidate.pluginId}`);
  }
  const after = await totalStorage(workspaceRoot, pluginRoots);
  console.log(`迁移后：工作区 ${formatBytes(after.workspace)}；插件库 ${formatBytes(after.plugins)}；总计 ${formatBytes(after.total)}`);
  console.log(`实际总占用减少 ${formatBytes(before.total - after.total)}；转换 ${candidates.length} 个旧插件副本。`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
  await pool.end();
}
