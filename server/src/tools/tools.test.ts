import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellTool } from './shell.js';
import { fileReadTool } from './fileRead.js';
import { fileWriteTool } from './fileWrite.js';
import { fileEditTool } from './fileEdit.js';
import { htmlArtifactTool } from './htmlArtifact.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { truncateFetchText } from './webFetch.js';
import { getTool, runTool, toolSchemas } from './registry.js';
import { publicDatasourceForTool } from './datasourceList.js';
import type { ToolResult } from './types.js';
import { normalizeToolSettings } from '../settings.js';

/** Tools may return a string or a ToolResult; tests assert on the text. */
const text = (r: string | ToolResult): string => (typeof r === 'string' ? r : r.text);

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
  assert.ok(schemas.find((s) => s.name === 'finish_conversation'));
  assert.ok(schemas.find((s) => s.name === 'write_html_artifact'));
  assert.ok(schemas.find((s) => s.name === 'skill_activate'));
  assert.ok(schemas.find((s) => s.name === 'datasource_list'));
  assert.ok(toolSchemas(['file_read']).some((s) => s.name === 'file_read'));
  assert.equal(toolSchemas(['file_read']).some((s) => s.name === 'shell'), false);
  assert.ok(toolSchemas(['file_read']).some((s) => s.name === 'finish_conversation'));
  assert.ok(toolSchemas(['datasource_list']).some((s) => s.name === 'datasource_list'));
  assert.ok(getTool('glob'));
  assert.match((await runTool('does_not_exist', {})).text, /未知工具/);
});

test('datasource_list public view redacts secrets and admin config', () => {
  const view = publicDatasourceForTool(
    {
      id: 'ds_1',
      name: 'sales',
      type: 'postgres',
      status: 'active',
      connection: { host: 'db.example.com', port: 5432, database: 'sales', password: 'secret' },
      admin_config: { connectionUrl: 'postgres://admin:secret@db.example.com/sales' },
      pool_config: {},
      created_at: '2026-06-13T00:00:00.000Z',
      updated_at: '2026-06-13T00:00:00.000Z',
    },
    [
      {
        id: 'dp_1',
        datasource_id: 'ds_1',
        name: 'readonly',
        mode: 'readonly',
        template_role: 'sales_readonly',
        grants: {},
        pool_config: {},
        created_at: '2026-06-13T00:00:00.000Z',
        updated_at: '2026-06-13T00:00:00.000Z',
      },
    ],
  );
  assert.equal(view.hasAdminConfig, true);
  assert.deepEqual(view.profiles, [{ name: 'readonly', mode: 'readonly', templateRole: 'sales_readonly' }]);
  assert.equal((view.connection as Record<string, unknown>).password, '[redacted]');
  assert.equal(JSON.stringify(view).includes('connectionUrl'), false);
  assert.equal(JSON.stringify(view).includes('postgres://admin'), false);
});

test('finish_conversation records progress and validates required progress', async () => {
  assert.match(
    (await runTool('finish_conversation', { progress: 'tests passed', completed: true })).text,
    /对话已完成/,
  );
  assert.match((await runTool('finish_conversation', { completed: true })).text, /必须填写.*progress/);
});

test('shell runs a command (PowerShell on Windows, sh elsewhere)', async () => {
  const out = text(await shellTool.run({ command: 'echo agent-shell-ok' }));
  assert.match(out, /agent-shell-ok/);
});

test('shell redacts credential-shaped output before returning it', async () => {
  const out = text(await shellTool.run({ command: "printf '%s\\n' '{\"password\":\"secret\",\"username\":\"agent\"}' 'DATABASE_URL=postgres://root:123456@localhost:5432/my_agent'" }));
  assert.match(out, /"password":"\[redacted\]"/);
  assert.match(out, /DATABASE_URL=\[redacted\]/);
  assert.equal(out.includes('secret'), false);
  assert.equal(out.includes('123456'), false);
});

test('shell inherits host PATH but not backend secret environment', async () => {
  const previous = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = 'sk-test-secret';
  try {
    const out = text(await shellTool.run(
      { command: 'printf "path=%s\\nhas_llm_api_key=%s\\n" "${PATH:+set}" "${LLM_API_KEY+yes}"' },
      { settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }) },
    ));
    assert.match(out, /path=set/);
    assert.match(out, /has_llm_api_key=\s*$/);
    assert.equal(out.includes('sk-test-secret'), false);
  } finally {
    if (previous == null) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previous;
  }
});

test('shell blocks database CLI before database-access injects a workload token', async () => {
  const blocked = text(await shellTool.run(
    { command: 'psql "$DATABASE_URL" -c "select 1"' },
    { settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }) },
  ));
  assert.match(blocked, /database-access/);
  assert.match(blocked, /workload token/);

  const allowed = text(await shellTool.run(
    { command: 'printf ok' },
    { settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }), env: { DB_WORKLOAD_TOKEN: 'wat_test' } },
  ));
  assert.equal(allowed, 'ok');
});

test('file_read reads content', async () => {
  const out = text(await fileReadTool.run({ path: join(dir, 'a.ts') }));
  assert.match(out, /export const a = 1/);
});

test('file_write creates file and parent dirs', async () => {
  const target = join(dir, 'nested', 'deep', 'c.txt');
  await fileWriteTool.run({ path: target, content: 'hi there' });
  assert.equal(await readFile(target, 'utf8'), 'hi there');
});

test('write_html_artifact creates a confined HTML file', async () => {
  const res = text(await htmlArtifactTool.run(
    { path: 'artifacts/demo.html', html: '<main>hello</main>' },
    { settings: normalizeToolSettings({ workspaceRoot: dir }) },
  ));
  assert.match(res, /HTML artifact 已写入：artifacts\/demo\.html/);
  const content = await readFile(join(dir, 'artifacts', 'demo.html'), 'utf8');
  assert.match(content, /<!doctype html>/i);
  assert.match(content, /<main>hello<\/main>/);
});

test('write_html_artifact rejects paths outside workspace', async () => {
  const res = text(await htmlArtifactTool.run(
    { path: '../escape.html', html: 'bad' },
    { settings: normalizeToolSettings({ workspaceRoot: dir }) },
  ));
  assert.match(res, /超出 workspace/);
});

test('file_edit replaces a unique string', async () => {
  const target = join(dir, 'edit.txt');
  await writeFile(target, 'one two three');
  const res = text(await fileEditTool.run({ path: target, old_string: 'two', new_string: 'TWO' }));
  assert.match(res, /已编辑/);
  assert.equal(await readFile(target, 'utf8'), 'one TWO three');
});

test('file_edit refuses non-unique or missing strings', async () => {
  const target = join(dir, 'dup.txt');
  await writeFile(target, 'x x x');
  assert.match(text(await fileEditTool.run({ path: target, old_string: 'x', new_string: 'y' })), /出现了 3 次/);
  assert.match(text(await fileEditTool.run({ path: target, old_string: 'zzz', new_string: 'y' })), /没有找到/);
});

test('glob matches by pattern', async () => {
  const out = text(await globTool.run({ pattern: '**/*.ts', path: dir }));
  assert.match(out, /a\.ts/);
  assert.match(out, /sub\/b\.ts/);
  assert.doesNotMatch(out, /readme\.md/);
});

test('grep finds matching lines with file:line', async () => {
  const out = text(await grepTool.run({ pattern: 'TODO', path: dir }));
  assert.match(out, /a\.ts:2/);
});

test('web_fetch truncation is visible to the model', () => {
  const out = truncateFetchText('a'.repeat(2000), 200);
  assert.ok(out.length <= 200);
  assert.match(out, /web_fetch 已按 max_chars 截断 \d+ 个字符/);
});

test('web_fetch truncation respects very small limits', () => {
  const out = truncateFetchText('a'.repeat(2000), 12);
  assert.ok(out.length <= 12);
});

test('tool settings clamp maxOutput to the context-safe ceiling', () => {
  const settings = normalizeToolSettings({ maxOutput: 100000 });
  assert.equal(settings.maxOutput, 40000);
});
