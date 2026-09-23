import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { scanStoragePath } from './service.js';

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('storage scanner counts symbolic links without following shared targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-usage-'));
  const shared = await mkdtemp(join(tmpdir(), 'runforge-usage-shared-'));
  tempDirs.push(root, shared);
  await mkdir(join(root, 'files'));
  await writeFile(join(root, 'files', 'local.txt'), 'local');
  await writeFile(join(shared, 'large.bin'), Buffer.alloc(32 * 1024));
  await symlink(relative(join(root, 'files'), shared), join(root, 'files', 'shared'), 'dir');

  const usage = await scanStoragePath(root);

  assert.equal(usage.fileCount, 1);
  assert.equal(usage.symlinkCount, 1);
  assert.ok(usage.logicalBytes < 1024, '链接目标里的大文件不应计入会话占用');
});
