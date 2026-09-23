import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { materializeWorkloadSdk } from '../workloadSdk/materialize.js';
import { loadSkillIndex, parseSkillDocument } from './registry.js';

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
