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
import { truncateFetchText } from './webFetch.js';
import { getTool, runTool, toolSchemas } from './registry.js';
import { publicDatasourceForTool } from './datasourceList.js';
import { shellExecTool } from './managedShell.js';
import { requiresDatabaseAccess } from './databaseAccessGuard.js';
import type { ToolResult, ToolRunContext } from './types.js';
import { normalizeMcpSettings, normalizeToolSettings } from '../settings.js';
import { shellCommandOptions, toolOptions } from '../api/settings.js';
import { mcpToolName, parseMcpToolName } from '../mcp/client.js';

/** 工具可能返回 string 或 ToolResult，测试统一取文本断言。 */
const text = (r: string | ToolResult): string => (typeof r === 'string' ? r : r.text);

let dir: string;
const emptyMcpSettings = { servers: [] };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runforge-test-'));
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n// TODO: fix\n');
  await writeFile(join(dir, 'sub', 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(dir, 'readme.md'), '# hello\n');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('registry exposes neutral tool schemas and dispatches by name', async () => {
  const schemas = await toolSchemas(undefined, emptyMcpSettings);
  assert.ok(schemas.find((s) => s.name === 'shell'));
  assert.equal(schemas.some((s) => s.name === 'finish_conversation'), false);
  assert.equal(schemas.some((s) => s.name.includes('artifact')), false);
  assert.ok(schemas.find((s) => s.name === 'skill_activate'));
  assert.ok(schemas.find((s) => s.name === 'workflow_list'));
  assert.ok(schemas.find((s) => s.name === 'workflow_read'));
  assert.ok(schemas.find((s) => s.name === 'datasource_list'));
  assert.ok((await toolSchemas(['file_read'], emptyMcpSettings)).some((s) => s.name === 'file_read'));
  assert.equal((await toolSchemas(['file_read'], emptyMcpSettings)).some((s) => s.name === 'shell'), false);
  assert.ok((await toolSchemas(['file_read'], emptyMcpSettings)).some((s) => s.name === 'update_plan'));
  assert.ok((await toolSchemas(['file_read'], emptyMcpSettings)).some((s) => s.name === 'workflow_read'));
  assert.ok((await toolSchemas(['datasource_list'], emptyMcpSettings)).some((s) => s.name === 'datasource_list'));
  assert.ok(getTool('glob'));
  assert.match((await runTool('does_not_exist', {})).text, /未知工具/);
});

test('tool settings options come from backend tool registry and command resolution', async () => {
  const tools = await toolOptions(emptyMcpSettings);
  assert.ok(tools.find((tool) => tool.name === 'shell'));
  assert.ok(tools.find((tool) => tool.name === 'file_read'));
  assert.equal(tools.some((tool) => tool.name === 'finish_conversation'), false);

  const commands = shellCommandOptions(['sh', 'definitely_missing_command_for_test', 'sh']);
  assert.deepEqual(commands.map((command) => command.name).sort(), ['definitely_missing_command_for_test', 'sh']);
  assert.equal(commands.find((command) => command.name === 'sh')?.available, true);
  assert.equal(commands.find((command) => command.name === 'definitely_missing_command_for_test')?.available, false);
});

test('mcp tool names are mapped into a separate namespace', () => {
  const name = mcpToolName('github', 'search');
  assert.equal(name, 'mcp__github__search');
  assert.deepEqual(parseMcpToolName(name), { serverId: 'github', toolName: 'search' });
  assert.equal(parseMcpToolName('search'), null);
});

test('mcp server ids cannot collide with the tool-name separator', () => {
  const settings = normalizeMcpSettings({ servers: [{ id: 'bad__server', label: 'Bad', url: 'https://example.com/mcp' }] });
  assert.equal(settings.servers[0].id, 'bad-server');
});

test('mcp settings only keep remote server connection fields', () => {
  const settings = normalizeMcpSettings({
    servers: [{
      id: 'local',
      label: 'Local',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/tmp',
      env: [{ name: 'API_KEY', value: 'secret' }],
      url: 'https://example.com/mcp',
    }],
  });
  const server = settings.servers[0] as unknown as Record<string, unknown>;
  assert.equal(server.url, 'https://example.com/mcp');
  assert.equal('transport' in server, false);
  assert.equal('command' in server, false);
  assert.equal('args' in server, false);
  assert.equal('cwd' in server, false);
  assert.equal('env' in server, false);
});

test('datasource_list public view redacts secrets and admin config', () => {
  const view = publicDatasourceForTool(
    {
      id: 'ds_1',
      name: 'sales',
      type: 'postgres',
      status: 'active',
      enabled: true,
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

test('registry forwards run context to tool implementations', async () => {
  const tool = getTool('shell');
  assert.ok(tool);
  const originalRun = tool.run;
  let seen: ToolRunContext | undefined;
  try {
    tool.run = async (_args, ctx) => {
      seen = ctx;
      return 'context-ok';
    };
    const settings = normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true });
    const out = await runTool('shell', { command: 'printf context-ok' }, {
      settings,
      env: { DB_WORKLOAD_TOKEN: 'wat_test' },
      threadId: 'th_test',
      runId: 'ru_test',
      stepId: 'st_test',
      step: 7,
    });
    assert.equal(out.text, 'context-ok');
    assert.equal(seen?.settings, settings);
    assert.deepEqual(seen?.env, { DB_WORKLOAD_TOKEN: 'wat_test' });
    assert.equal(seen?.threadId, 'th_test');
    assert.equal(seen?.runId, 'ru_test');
    assert.equal(seen?.stepId, 'st_test');
    assert.equal(seen?.step, 7);
  } finally {
    tool.run = originalRun;
  }
});

test('workflow_read explains same-name skill instead of reading skill workflows as RunForge workflows', async () => {
  const skillRoot = join(dir, '.skills', 'ppt-master');
  await mkdir(join(skillRoot, 'workflows'), { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    [
      '---',
      'name: ppt-master',
      'description: Generate presentation artifacts.',
      '---',
      '',
      '# PPT Master',
      '',
      'See workflows/index.md for the skill internal workflow.',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(skillRoot, 'workflows', 'index.md'), '# Internal skill workflow\n', 'utf8');

  const out = await runTool(
    'workflow_read',
    { name: 'ppt-master' },
    { settings: normalizeToolSettings({ workspaceRoot: dir }) },
  );

  assert.match(out.text, /未找到 RunForge workflow: ppt-master/);
  assert.match(out.text, /但找到了同名 skill: ppt-master/);
  assert.match(out.text, /skill root:/);
  assert.match(out.text, /skill_activate/);
  assert.match(out.text, /skill 内部的 workflows\/\*\.md 属于该 skill 的普通资源/);
});

test('shell runs a command (PowerShell on Windows, sh elsewhere)', async () => {
  const out = text(await shellTool.run({ command: 'echo agent-shell-ok' }));
  assert.match(out, /agent-shell-ok/);
});

test('shell redacts credential-shaped output before returning it', async () => {
  const out = text(await shellTool.run({ command: "printf '%s\\n' '{\"password\":\"secret\",\"username\":\"agent\"}' 'DATABASE_URL=postgres://root:123456@localhost:5432/runforge'" }));
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

test('shell blocks database-access SDK scripts before workload token injection', async () => {
  const command = `python3 ${dir}/.agents/skills/database-access/scripts/psql_query.py --sql "select 1"`;
  assert.equal(requiresDatabaseAccess(command), true);
  const blockedShell = text(await shellTool.run(
    { command },
    { settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }) },
  ));
  assert.match(blockedShell, /database-access/);
  assert.match(blockedShell, /workload token/);

  const blockedManaged = text(await shellExecTool.run(
    { sessionId: 'ss_test', command, wait: 'foreground' },
    { settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }), threadId: 'th_test' },
  ));
  assert.match(blockedManaged, /database-access/);
  assert.match(blockedManaged, /workload token/);
});

test('shell blocks direct database CLI even when workload token exists', async () => {
  const command = 'psql -h localhost -U ag_readonly_old -d runforge -c "select 1"';
  const blocked = text(await shellTool.run(
    { command },
    { settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }), env: { DB_WORKLOAD_TOKEN: 'wat_test' } },
  ));
  assert.match(blocked, /直接调用数据库 CLI/);
  assert.match(blocked, /短期凭证/);
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
