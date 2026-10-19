import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { materializeWorkloadSdk } from '../workloadSdk/materialize.js';
import { loadSkillIndex, parseSkillDocument } from './registry.js';
import { WorkspacePathAccessError } from '../files/workspace.js';
import { normalizeToolSettings } from '../settings.js';
import { fileWriteTool } from '../tools/fileWrite.js';

test('内置 Skill 和 SDK 按空间共享，会话内自建 Skill 不进入目录', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-managed-skills-'));
  try {
    const spaceRoot = join(base, 'sp_test');
    const first = join(spaceRoot, 'c', 'th_first');
    const second = join(spaceRoot, 'c', 'th_second');
    const builtinSource = join(base, 'builtin');
    const source = join(builtinSource, 'sample');
    await mkdir(source, { recursive: true });
    await mkdir(join(first, '.skills', 'self-authored'), { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), [
      '---', 'name: sample', 'description: >', '  Shared skill with', '  a folded description.', '---', '', '# Shared',
      '<!-- @internal hidden -->',
    ].join('\n'));
    await writeFile(join(first, '.skills', 'self-authored', 'SKILL.md'), [
      '---', 'name: self-authored', 'description: Not published.', '---', '', '# Private',
    ].join('\n'));

    const firstIndex = await loadSkillIndex(first, builtinSource, spaceRoot);
    const secondIndex = await loadSkillIndex(second, builtinSource, spaceRoot);
    assert.deepEqual(firstIndex.map((item) => item.id), ['builtin:sample']);
    assert.deepEqual(secondIndex.map((item) => item.id), ['builtin:sample']);
    assert.equal(firstIndex[0].description, 'Shared skill with a folded description.');
    const firstLink = join(first, '.agents', 'skills', 'sample');
    const secondLink = join(second, '.agents', 'skills', 'sample');
    assert.equal((await lstat(firstLink)).isSymbolicLink(), true);
    assert.equal((await lstat(secondLink)).isSymbolicLink(), true);
    assert.equal((await readlink(firstLink)).startsWith('/'), false);
    assert.equal(await realpath(firstLink), await realpath(secondLink));
    assert.doesNotMatch(await readFile(join(firstLink, 'SKILL.md'), 'utf8'), /@internal/);

    const firstSdk = await materializeWorkloadSdk(first, spaceRoot);
    const secondSdk = await materializeWorkloadSdk(second, spaceRoot);
    assert.equal(await realpath(firstSdk), await realpath(secondSdk));
    assert.equal((await readlink(dirname(firstSdk))).startsWith('/'), false);
    assert.equal(resolve(firstSdk).startsWith(first), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Skill YAML 折叠说明在目录索引中保持完整', () => {
  const parsed = parseSkillDocument([
    '---', 'name: chart', 'description: >', '  Line one.', '  Line two.', '---', '', '# Chart',
  ].join('\n'), '/tmp/chart/SKILL.md');
  assert.equal(parsed.frontmatter.description, 'Line one. Line two.');
});

test('物化保留文件权限和脚本执行位，重复准备与版本切换不修改原资源', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-resource-permissions-'));
  const spaceRoot = join(base, 'space');
  const workspaceRoot = join(spaceRoot, 'c', 'thread');
  const sourceRoot = join(base, 'builtin');
  const source = join(sourceRoot, 'sample');
  const outside = join(base, 'user-original');
  try {
    await mkdir(source, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '---\nname: sample\ndescription: 示例\n---\n第一版');
    await writeFile(join(source, 'run.sh'), '#!/bin/sh\nprintf ok\n');
    await chmod(join(source, 'run.sh'), 0o755);
    await writeFile(join(outside, 'note.txt'), '用户原文件');
    await chmod(join(outside, 'note.txt'), 0o640);
    await symlink(outside, join(source, 'user-link'), 'dir');
    const originalMode = (await stat(join(source, 'SKILL.md'))).mode;
    const first = (await loadSkillIndex(workspaceRoot, sourceRoot, spaceRoot))[0];
    const firstTarget = await realpath(first.root);
    assert.equal((await stat(join(firstTarget, 'SKILL.md'))).mode, originalMode);
    assert.equal((await stat(join(firstTarget, 'run.sh'))).mode & 0o111, 0o111);
    assert.equal((await stat(firstTarget)).mode & 0o111, 0o111);
    assert.equal((await stat(join(outside, 'note.txt'))).mode & 0o777, 0o640);
    assert.equal((await stat(join(source, 'SKILL.md'))).mode, originalMode);
    assert.equal(await realpath((await loadSkillIndex(workspaceRoot, sourceRoot, spaceRoot))[0].root), firstTarget);
    const sdk = await materializeWorkloadSdk(workspaceRoot, spaceRoot);
    assert.equal(await materializeWorkloadSdk(workspaceRoot, spaceRoot), sdk);

    const ctx = {
      scope: { tenantId: 'tn_readonly', userId: 'us_readonly' },
      settings: normalizeToolSettings({ workspaceRoot }),
      managedReadRoots: [first.root],
    };
    await assert.rejects(
      fileWriteTool.run({ path: join(first.root, 'SKILL.md'), content: '篡改' }, ctx),
      WorkspacePathAccessError,
    );
    await fileWriteTool.run({ path: 'out.json', content: '{}' }, ctx);
    assert.equal(await readFile(join(workspaceRoot, 'out.json'), 'utf8'), '{}');

    await writeFile(join(source, 'SKILL.md'), '---\nname: sample\ndescription: 示例\n---\n第二版');
    const second = (await loadSkillIndex(workspaceRoot, sourceRoot, spaceRoot))[0];
    assert.notEqual(await realpath(second.root), firstTarget);
    assert.match(await readFile(join(firstTarget, 'SKILL.md'), 'utf8'), /第一版/);
    assert.match(await readFile(join(second.root, 'SKILL.md'), 'utf8'), /第二版/);
    await rm(source, { recursive: true });
    assert.deepEqual(await loadSkillIndex(workspaceRoot, sourceRoot, spaceRoot), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
