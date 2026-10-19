import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveWebWorkspaceFilePath, resolveWorkspaceFilePath, WorkspacePathAccessError } from './workspace.js';
import { ensureManagedDirectory, ensureManagedLink } from './managedResources.js';
import { removeSpaceWorkspace, removeThreadWorkspace, resolveThreadWorkspaceRoot } from './workspaceRoot.js';

test('Agent file paths allow ordinary thread files and only selected resource links', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-workspace-path-'));
  const thread = join(base, 'space', 'c', 'thread');
  const spaceSkills = join(base, 'space', '.skills');
  const pluginRoot = join(base, 'tenant', '.runforge-snapshots', 'crm', 'hash', 'plugin');
  const unselectedPluginRoot = join(base, 'tenant', '.runforge-snapshots', 'other', 'hash', 'plugin');
  const outside = join(base, 'private');
  try {
    await Promise.all([
      mkdir(join(thread, '.agents', 'skills'), { recursive: true }),
      mkdir(join(thread, 'plugins', 'legacy'), { recursive: true }),
      mkdir(join(spaceSkills, 'selected'), { recursive: true }),
      mkdir(join(spaceSkills, 'unselected'), { recursive: true }),
      mkdir(pluginRoot, { recursive: true }),
      mkdir(unselectedPluginRoot, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(thread, 'note.txt'), 'thread file');
    await writeFile(join(spaceSkills, 'selected', 'SKILL.md'), 'selected skill');
    await writeFile(join(spaceSkills, 'unselected', 'SKILL.md'), 'unselected skill');
    await writeFile(join(pluginRoot, 'index.ts'), 'selected plugin');
    await writeFile(join(unselectedPluginRoot, 'index.ts'), 'unselected plugin');
    await writeFile(join(thread, 'plugins', 'legacy', 'index.ts'), 'legacy plugin');
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(relative(join(thread, '.agents', 'skills'), join(spaceSkills, 'selected')), join(thread, '.agents', 'skills', 'selected'), 'dir');
    await symlink(relative(join(thread, '.agents', 'skills'), join(spaceSkills, 'unselected')), join(thread, '.agents', 'skills', 'unselected'), 'dir');
    await symlink(relative(join(thread, 'plugins'), pluginRoot), join(thread, 'plugins', 'crm'), 'dir');
    await symlink(relative(join(thread, 'plugins'), unselectedPluginRoot), join(thread, 'plugins', 'other'), 'dir');
    await symlink(outside, join(thread, 'private-link'), 'dir');

    assert.equal(await readFile(await resolveWorkspaceFilePath(thread, 'note.txt', { access: 'read' }), 'utf8'), 'thread file');
    const selectedSkillLink = join(thread, '.agents', 'skills', 'selected');
    assert.equal(await readFile(await resolveWorkspaceFilePath(thread, '.agents/skills/selected/SKILL.md', {
      access: 'read', managedReadRoots: [selectedSkillLink],
    }), 'utf8'), 'selected skill');
    assert.equal(await readFile(await resolveWorkspaceFilePath(thread, 'plugins/crm/index.ts', {
      access: 'read', pluginRoots: [pluginRoot],
    }), 'utf8'), 'selected plugin');

    await assert.rejects(
      resolveWorkspaceFilePath(thread, '.agents/skills/unselected/SKILL.md', { access: 'read', managedReadRoots: [selectedSkillLink] }),
      WorkspacePathAccessError,
    );
    await assert.rejects(
      resolveWorkspaceFilePath(thread, 'plugins/other/index.ts', { access: 'read', pluginRoots: [pluginRoot] }),
      WorkspacePathAccessError,
    );
    await assert.rejects(
      resolveWorkspaceFilePath(thread, 'plugins/legacy/index.ts', { access: 'read', pluginRoots: [pluginRoot] }),
      WorkspacePathAccessError,
    );
    await assert.rejects(
      resolveWorkspaceFilePath(thread, 'private-link/secret.txt', { access: 'read' }),
      WorkspacePathAccessError,
    );
    await assert.rejects(
      resolveWorkspaceFilePath(thread, 'plugins/crm/index.ts', { access: 'write', pluginRoots: [pluginRoot] }),
      WorkspacePathAccessError,
    );
    await assert.rejects(
      resolveWorkspaceFilePath(thread, 'plugins/other/index.ts', { access: 'write', pluginRoots: [pluginRoot] }),
      WorkspacePathAccessError,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Web file paths reject managed resources and every symbolic link', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-web-workspace-path-'));
  const thread = join(base, 'space', 'c', 'thread');
  const managed = join(base, 'space', '.skills');
  const outside = join(base, 'outside');
  try {
    await Promise.all([
      mkdir(thread, { recursive: true }),
      mkdir(managed, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(thread, 'note.txt'), 'thread file');
    await writeFile(join(managed, 'skill.md'), 'managed skill');
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(managed, join(thread, '.agents'), 'dir');
    await symlink(outside, join(thread, 'private-link'), 'dir');

    assert.equal(await resolveWebWorkspaceFilePath(thread, 'note.txt'), join(thread, 'note.txt'));
    await assert.rejects(resolveWebWorkspaceFilePath(thread, '.agents/flow.md'), WorkspacePathAccessError);
    await assert.rejects(resolveWebWorkspaceFilePath(thread, 'private-link/secret.txt'), WorkspacePathAccessError);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('并发发布只读版本后可重复准备，替换旧入口时不会修改被链接的旧版本', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-managed-publish-'));
  const version = join(base, 'space', '.skills', 'sample', 'v1');
  const next = join(base, 'space', '.skills', 'sample', 'v2');
  const entry = join(base, 'space', 'c', 'thread', '.agents', 'skills', 'sample');
  try {
    const materialize = async (staging: string) => {
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'SKILL.md'), '第一版');
    };
    await Promise.all([ensureManagedDirectory(version, materialize), ensureManagedDirectory(version, materialize)]);
    await ensureManagedDirectory(version, async () => { throw new Error('已有版本不应再次复制'); });
    assert.deepEqual(await readdir(join(base, 'space', '.skills', 'sample')), ['v1']);
    await ensureManagedLink(version, entry);
    await ensureManagedDirectory(next, async (staging) => {
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'SKILL.md'), '第二版');
    });
    await ensureManagedLink(next, entry);
    assert.equal(await readFile(join(entry, 'SKILL.md'), 'utf8'), '第二版');
    assert.equal(await readFile(join(version, 'SKILL.md'), 'utf8'), '第一版');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('线程清理保留共享版本，空间清理不跟随用户原目录链接', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-managed-cleanup-'));
  const space = join(base, 'sp_test');
  const thread = resolveThreadWorkspaceRoot('sp_test', 'th_test', base);
  const shared = join(space, '.skills', 'selected');
  const original = join(base, 'user-original');
  try {
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'SKILL.md'), '共享版本');
    await ensureManagedLink(shared, join(thread, '.agents', 'skills', 'selected'));
    await mkdir(original);
    await chmod(original, 0o750);
    await writeFile(join(original, 'note.txt'), '用户原文件');
    await chmod(join(original, 'note.txt'), 0o640);
    await symlink(original, join(space, 'user-link'), 'dir');
    await removeThreadWorkspace('sp_test', 'th_test', base);
    await assert.rejects(lstat(thread), { code: 'ENOENT' });
    assert.equal(await readFile(join(shared, 'SKILL.md'), 'utf8'), '共享版本');
    await removeSpaceWorkspace('sp_test', base);
    await assert.rejects(lstat(space), { code: 'ENOENT' });
    assert.equal((await stat(original)).mode & 0o777, 0o750);
    assert.equal((await stat(join(original, 'note.txt'))).mode & 0o777, 0o640);
    assert.equal(await readFile(join(original, 'note.txt'), 'utf8'), '用户原文件');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
