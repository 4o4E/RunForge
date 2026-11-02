import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../plugins/business/daily-news-research/skills/daily-news-research/scripts/news-history.mjs', import.meta.url));

test('新闻历史CLI通过符号链接启动时，缺少参数必须返回失败而不是静默成功', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runforge-news-history-cli-'));
  try {
    const linked = join(directory, 'news-history.mjs');
    await symlink(script, linked);
    const result = spawnSync(process.execPath, [linked], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
