import assert from 'node:assert/strict';
import test from 'node:test';
import { fileTabForPath, workspacePathFromHref } from './fileLinks';

test('工作文件和用户文件链接进入各自的右侧面板', () => {
  const workspaceRoot = '/w/sp_example/c/th_example';
  const userFilesRoot = '/u/us_example';

  assert.equal(fileTabForPath(workspacePathFromHref('artifacts/report.md', workspaceRoot)!, workspaceRoot, userFilesRoot), 'file:artifacts/report.md');
  assert.equal(fileTabForPath(workspacePathFromHref(`${workspaceRoot}/artifacts/`, workspaceRoot)!, workspaceRoot, userFilesRoot), 'file:artifacts/');
  assert.equal(fileTabForPath(workspacePathFromHref(`${userFilesRoot}/资料/`, workspaceRoot)!, workspaceRoot, userFilesRoot), 'user-file:资料/');
  assert.equal(fileTabForPath(workspacePathFromHref(`file://${userFilesRoot}/notes.md`, workspaceRoot)!, workspaceRoot, userFilesRoot), 'user-file:notes.md');
  assert.equal(fileTabForPath(workspacePathFromHref('.', workspaceRoot)!, workspaceRoot, userFilesRoot), 'file:.');
  assert.throws(() => fileTabForPath('/u/us_other/notes.md', workspaceRoot, userFilesRoot), /不属于当前工作区或用户文件目录/);
});

test('外部网址和工作区之外的绝对路径保持普通链接', () => {
  const root = '/w/sp_example/c/th_example';
  assert.equal(workspacePathFromHref('https://example.com/report', root), null);
  assert.equal(workspacePathFromHref('/tmp/report.md', root), null);
  assert.equal(workspacePathFromHref('../other/report.md', root), null);
});
