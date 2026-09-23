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

test('thread storage scan counts resource links without following space targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-usage-'));
  const shared = await mkdtemp(join(tmpdir(), 'runforge-usage-shared-'));
  tempDirs.push(root, shared);
  const threadRoot = join(root, 'space-1', 'c', 'thread-1');
  await mkdir(threadRoot, { recursive: true });
  await writeFile(join(threadRoot, 'local.txt'), 'local');
  await mkdir(join(root, 'space-1', '.skills'));
  await writeFile(join(shared, 'large.bin'), Buffer.alloc(32 * 1024));
  await symlink(relative(threadRoot, shared), join(threadRoot, '.skills'), 'dir');

  const usage = await scanStoragePath(threadRoot);

  assert.equal(usage.fileCount, 1);
  assert.equal(usage.symlinkCount, 1);
  assert.ok(usage.logicalBytes < 1024, '空间资源链接目标里的大文件不应重复计入会话占用');
});
