import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveWebWorkspaceFilePath, resolveWorkspaceFilePath, WorkspacePathAccessError } from './workspace.js';

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
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Web file paths reject managed resources and every symbolic link', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-web-workspace-path-'));
  const thread = join(base, 'space', 'c', 'thread');
  const managed = join(base, 'space', '.workflows');
  const outside = join(base, 'outside');
  try {
    await Promise.all([
      mkdir(thread, { recursive: true }),
      mkdir(managed, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(thread, 'note.txt'), 'thread file');
    await writeFile(join(managed, 'flow.md'), 'managed flow');
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
