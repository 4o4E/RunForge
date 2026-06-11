import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellTool } from './shell.js';
import { fileReadTool } from './fileRead.js';
import { fileWriteTool } from './fileWrite.js';
import { fileEditTool } from './fileEdit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { getTool, runTool, toolSchemas } from './registry.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'my-agent-test-'));
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n// TODO: fix\n');
  await writeFile(join(dir, 'sub', 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(dir, 'readme.md'), '# hello\n');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('registry exposes neutral tool schemas and dispatches by name', async () => {
  const schemas = toolSchemas();
  assert.ok(schemas.find((s) => s.name === 'shell'));
  assert.ok(getTool('glob'));
  assert.match(await runTool('does_not_exist', {}), /Unknown tool/);
});

test('shell runs a command (PowerShell on Windows, sh elsewhere)', async () => {
  const out = await shellTool.run({ command: 'echo agent-shell-ok' });
  assert.match(out, /agent-shell-ok/);
});

test('file_read reads content', async () => {
  const out = await fileReadTool.run({ path: join(dir, 'a.ts') });
  assert.match(out, /export const a = 1/);
});

test('file_write creates file and parent dirs', async () => {
  const target = join(dir, 'nested', 'deep', 'c.txt');
  await fileWriteTool.run({ path: target, content: 'hi there' });
  assert.equal(await readFile(target, 'utf8'), 'hi there');
});

test('file_edit replaces a unique string', async () => {
  const target = join(dir, 'edit.txt');
  await writeFile(target, 'one two three');
  const res = await fileEditTool.run({ path: target, old_string: 'two', new_string: 'TWO' });
  assert.match(res, /Edited/);
  assert.equal(await readFile(target, 'utf8'), 'one TWO three');
});

test('file_edit refuses non-unique or missing strings', async () => {
  const target = join(dir, 'dup.txt');
  await writeFile(target, 'x x x');
  assert.match(await fileEditTool.run({ path: target, old_string: 'x', new_string: 'y' }), /appears 3 times/);
  assert.match(await fileEditTool.run({ path: target, old_string: 'zzz', new_string: 'y' }), /not found/);
});

test('glob matches by pattern', async () => {
  const out = await globTool.run({ pattern: '**/*.ts', path: dir });
  assert.match(out, /a\.ts/);
  assert.match(out, /sub\/b\.ts/);
  assert.doesNotMatch(out, /readme\.md/);
});

test('grep finds matching lines with file:line', async () => {
  const out = await grepTool.run({ pattern: 'TODO', path: dir });
  assert.match(out, /a\.ts:2/);
});
