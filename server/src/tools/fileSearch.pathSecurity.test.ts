import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '../store/types.js';
import { normalizeToolSettings } from '../settings.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';

const scope: Scope = { tenantId: 'default', userId: 'file-search-path-security' };

test('glob and grep skip nested file and directory symlinks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-file-search-security-'));
  const workspace = join(base, 'thread');
  const outside = join(base, 'outside');
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(workspace, 'nested'), { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(workspace, 'normal.txt'), 'normal content');
    await writeFile(join(outside, 'secret.txt'), 'secret needle');
    await symlink(join(outside, 'secret.txt'), join(workspace, 'nested', 'linked.txt'), 'file');
    await symlink(outside, join(workspace, 'linked-directory'), 'dir');
    const ctx = { scope, settings: normalizeToolSettings({ workspaceRoot: workspace }) };

    const glob = await globTool.run({ pattern: '**/*' }, ctx);
    assert.equal(glob, 'normal.txt');
    const grep = await grepTool.run({ pattern: 'needle' }, ctx);
    assert.equal(grep, '（没有匹配项）');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
