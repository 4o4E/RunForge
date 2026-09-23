import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

const apply = process.argv.slice(2).includes('--apply');
if (process.argv.slice(2).some((arg) => arg !== '--apply')) {
  throw new Error('用法：cleanLegacyThreadWorkspaces [--apply]；默认只预览');
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function activeWorkCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(`
    SELECT (
      (SELECT count(*) FROM runs WHERE status IN ('pending', 'running', 'canceling'))
      + (SELECT count(*) FROM subagent_runs WHERE status = 'running')
      + (SELECT count(*) FROM shell_commands WHERE status IN ('queued', 'running'))
      + (SELECT count(*) FROM shell_sessions WHERE status = 'busy')
    )::text AS count
  `);
  return Number(result.rows[0].count);
}

/** 只清理旧版 `th_*` 会话目录，包括数据库记录已删除后遗留的目录。 */
async function main(): Promise<void> {
  const base = resolve(config.tools.workspaceRoot);
  const baseReal = await realpath(base);
  const targets: string[] = [];
  for (const spaceEntry of await readdir(base, { withFileTypes: true })) {
    if (/^th_[0-9A-Za-z_-]+$/.test(spaceEntry.name)) {
      const legacyRoot = resolve(base, spaceEntry.name);
      if (!spaceEntry.isDirectory() || await realpath(legacyRoot) !== legacyRoot) {
        throw new Error(`工作区根下的旧会话目标不是普通目录：${legacyRoot}`);
      }
      targets.push(legacyRoot);
      continue;
    }
    if (!/^sp_[0-9A-Za-z_-]+$/.test(spaceEntry.name)) continue;
    const spaceRoot = resolve(base, spaceEntry.name);
    if (!spaceEntry.isDirectory() || !inside(baseReal, await realpath(spaceRoot))) {
      throw new Error(`空间目录不是工作区内普通目录：${spaceRoot}`);
    }
    for (const threadEntry of await readdir(spaceRoot, { withFileTypes: true })) {
      if (!/^th_[0-9A-Za-z_-]+$/.test(threadEntry.name)) continue;
      const target = resolve(spaceRoot, threadEntry.name);
      if (!inside(spaceRoot, target) || !threadEntry.isDirectory()) {
        throw new Error(`旧会话目标不是普通目录：${target}`);
      }
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) {
        throw new Error(`旧会话目录经过符号链接：${target}`);
      }
      targets.push(target);
    }
  }

  const active = await activeWorkCount();
  console.log(`发现 ${targets.length} 个旧会话目录；未结束的运行或 Shell 项目 ${active} 个。`);
  if (!apply) {
    console.log('当前为预览；确认服务已停止且无活动任务后使用 --apply 清理。');
    return;
  }
  if (active) throw new Error('存在未结束的运行或 Shell 命令，拒绝清理旧会话文件');
  for (const target of targets) {
    await rm(target, { recursive: true });
    console.log(`已清理 ${target}`);
  }
  console.log(`已清理 ${targets.length} 个旧会话目录；数据库记录未修改。`);
}

try {
  await main();
} finally {
  await pool.end();
}
