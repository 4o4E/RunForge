import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import sharp from 'sharp';
import { shellTool } from './shell.js';
import { fileReadTool } from './fileRead.js';
import { fileWriteTool } from './fileWrite.js';
import { fileEditTool } from './fileEdit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { truncateFetchText } from './webFetch.js';
import { getTool, runTool, toolSchemas } from './registry.js';
import { shellExecTool, shellPollTool } from './managedShell.js';
import { ShellManager, shellManager } from '../shell/manager.js';
import { shellBus } from '../shell/bus.js';
import { store as shellStore } from '../store/index.js';
import type { AgentEvent } from '../agent/types.js';
import { requiresDatabaseAccess } from './databaseAccessGuard.js';
import type { ToolResult, ToolRunContext } from './types.js';
import { normalizeMcpSettings, normalizeToolSettings } from '../settings.js';
import { resolveToolActivation } from './onDemand.js';
import { mcpToolName, parseMcpToolName } from '../mcp/client.js';
import type { Scope } from '../store/types.js';

/** 工具可能返回 string 或 ToolResult，测试统一取文本断言。 */
const text = (r: string | ToolResult): string => (typeof r === 'string' ? r : r.text);

let dir: string;
const TEST_SCOPE: Scope = { tenantId: 'default', userId: 'us_test' };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runforge-test-'));
  await mkdir(join(dir, 'sub'), { recursive: true });
  await mkdir(join(dir, '健身'), { recursive: true });
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n// TODO: fix\n');
  await writeFile(join(dir, 'sub', 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(dir, '健身', '背景信息.md'), '# 训练背景\n');
  await writeFile(join(dir, 'readme.md'), '# hello\n');
  await writeFile(join(dir, 'frame.png'), await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer());
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('registry exposes neutral tool schemas and dispatches by name', async () => {
  const schemas = await toolSchemas();
  assert.ok(schemas.find((s) => s.name === 'shell'));
  assert.equal(schemas.some((s) => s.name === 'finish_conversation'), false);
  assert.equal(schemas.some((s) => s.name.includes('artifact')), false);
  assert.ok(schemas.find((s) => s.name === 'skill_activate'));
  assert.ok(schemas.find((s) => s.name === 'mcp_activate'));
  assert.equal(schemas.some((s) => s.name === 'workflow_list' || s.name === 'workflow_read'), false);
  assert.equal(schemas.some((s) => s.name === 'datasource_list'), false);
  assert.ok((await toolSchemas(['file_read'])).some((s) => s.name === 'file_read'));
  assert.equal((await toolSchemas(['file_read'])).some((s) => s.name === 'shell'), false);
  assert.equal(schemas.some((s) => s.name === 'tools_activate'), false);
  const onDemandSchemas = await toolSchemas(['shell', 'tools_activate'], [], false);
  assert.deepEqual(onDemandSchemas.map((schema) => schema.name), ['shell', 'tools_activate']);
  assert.ok((await toolSchemas(['file_read'])).some((s) => s.name === 'update_plan'));
  assert.ok(getTool('glob'));
  assert.match((await runTool('does_not_exist', {}, { scope: TEST_SCOPE })).text, /未知工具/);
});

test('on-demand tool activation stays inside the allowed tool set', () => {
  const active = new Set(['file_read']);
  assert.deepEqual(
    resolveToolActivation(['file_read', 'glob', 'glob'], ['file_read', 'glob', 'shell'], ['file_read'], active),
    { additions: ['glob'], error: null },
  );
  assert.deepEqual(
    resolveToolActivation(['shell', 'mcp__hidden__query'], ['file_read', 'shell'], ['file_read'], active),
    { additions: [], error: '工具未获当前空间授权：mcp__hidden__query' },
  );
  assert.deepEqual(
    resolveToolActivation(['ask_user'], ['file_read', 'shell'], ['file_read'], active),
    { additions: [], error: '工具未获当前空间授权：ask_user' },
  );
});

test('mcp tool names are mapped into a separate namespace', () => {
  const name = mcpToolName('github', 'search');
  assert.equal(name, 'mcp__github__search');
  assert.deepEqual(parseMcpToolName(name), { serverId: 'github', toolName: 'search' });
  assert.equal(parseMcpToolName('search'), null);
});

test('MCP schema and execution require current-run activation', async () => {
  const mappedTool = {
    serverId: 'github',
    serverLabel: 'GitHub',
    originalName: 'search',
    mappedName: mcpToolName('github', 'search'),
    description: '搜索仓库',
    parameters: { type: 'object' },
  };
  assert.equal((await toolSchemas()).some((tool) => tool.name === mappedTool.mappedName), false);
  assert.equal((await toolSchemas(undefined, [mappedTool])).some((tool) => tool.name === mappedTool.mappedName), true);

  const settings = normalizeMcpSettings({
    servers: [{ id: 'github', label: 'GitHub', description: '代码托管能力', enabled: true, url: 'https://example.com/mcp' }],
  });
  const blocked = await runTool(mappedTool.mappedName, { query: 'runforge' }, {
    scope: TEST_SCOPE,
    mcpSettings: settings,
    activeMcpServerIds: new Set(),
  });
  assert.match(blocked.text, /尚未在当前 run 激活/);
});

test('mcp server ids cannot collide with the tool-name separator', () => {
  const settings = normalizeMcpSettings({ servers: [{ id: 'bad__server', label: 'Bad', url: 'https://example.com/mcp' }] });
  assert.equal(settings.servers[0].id, 'bad-server');
});

test('mcp settings keep connection and activation-routing fields', () => {
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
  assert.equal(server.description, 'Local');
  assert.equal('allowedTools' in server, false);
  assert.equal('transport' in server, false);
  assert.equal('command' in server, false);
  assert.equal('args' in server, false);
  assert.equal('cwd' in server, false);
  assert.equal('env' in server, false);
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
      scope: TEST_SCOPE,
      settings,
      env: { WORKLOAD_TOKEN: 'wlt_test' },
      threadId: 'th_test',
      runId: 'ru_test',
      stepId: 'st_test',
      step: 7,
    });
    assert.equal(out.text, 'context-ok');
    assert.equal(seen?.settings, settings);
    assert.deepEqual(seen?.env, { WORKLOAD_TOKEN: 'wlt_test' });
    assert.equal(seen?.threadId, 'th_test');
    assert.equal(seen?.runId, 'ru_test');
    assert.equal(seen?.stepId, 'st_test');
    assert.equal(seen?.step, 7);
  } finally {
    tool.run = originalRun;
  }
});

test('shell runs a command (PowerShell on Windows, sh elsewhere)', async () => {
  const out = text(await shellTool.run({ command: 'echo agent-shell-ok' }, { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir }) }));
  assert.match(out, /agent-shell-ok/);
});

test('shell redacts credential-shaped output before returning it', async () => {
  const out = text(await shellTool.run({ command: "printf '%s\\n' '{\"password\":\"secret\",\"username\":\"agent\"}' 'DATABASE_URL=postgres://root:123456@localhost:5432/runforge'" }, { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir }) }));
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
      { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }) },
    ));
    assert.match(out, /path=set/);
    assert.match(out, /has_llm_api_key=\s*$/);
    assert.equal(out.includes('sk-test-secret'), false);
  } finally {
    if (previous == null) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previous;
  }
});

test('shell blocks database CLI when the run workload token is missing', async () => {
  const blocked = text(await shellTool.run(
    { command: 'psql "$DATABASE_URL" -c "select 1"' },
    { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }) },
  ));
  assert.match(blocked, /初始化异常/);
  assert.match(blocked, /WORKLOAD_TOKEN/);

  const allowed = text(await shellTool.run(
    { command: 'printf ok' },
    { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }), env: { WORKLOAD_TOKEN: 'wlt_test' } },
  ));
  assert.equal(allowed, 'ok');
});

test('shell blocks database-access SDK scripts when the run workload token is missing', async () => {
  const command = `node ${dir}/.agents/skills/database-access/scripts/psql-query.mjs --sql "select 1"`;
  assert.equal(requiresDatabaseAccess(command), true);
  const blockedShell = text(await shellTool.run(
    { command },
    { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }) },
  ));
  assert.match(blockedShell, /初始化异常/);
  assert.match(blockedShell, /WORKLOAD_TOKEN/);

  const blockedManaged = text(await shellExecTool.run(
    { sessionId: 'ss_test', command, wait: 'foreground' },
    { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }), threadId: 'th_test' },
  ));
  assert.match(blockedManaged, /初始化异常/);
  assert.match(blockedManaged, /WORKLOAD_TOKEN/);
});

test('shell blocks direct database CLI even when workload token exists', async () => {
  const command = 'psql -h localhost -U ag_readonly_old -d runforge -c "select 1"';
  const blocked = text(await shellTool.run(
    { command },
    { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir, shellUseHostPath: true }), env: { WORKLOAD_TOKEN: 'wlt_test' } },
  ));
  assert.match(blocked, /直接调用数据库 CLI/);
  assert.match(blocked, /短期凭证/);
});

test('file_read reads content', async () => {
  const out = text(await fileReadTool.run({ path: join(dir, 'a.ts') }));
  assert.match(out, /export const a = 1/);
});

test('file_read returns PNG as a model image part', async () => {
  const out = await fileReadTool.run(
    { path: 'frame.png' },
    { scope: TEST_SCOPE, settings: normalizeToolSettings({ workspaceRoot: dir }) },
  );
  assert.equal(typeof out, 'object');
  const result = out as ToolResult;
  assert.equal(result.contentParts?.[0]?.type, 'image');
  assert.equal(result.contentParts?.[0]?.mimeType, 'image/png');
});

test('file tools resolve relative paths from workspaceRoot', async () => {
  const settings = normalizeToolSettings({ workspaceRoot: dir });
  const ctx = { scope: TEST_SCOPE, settings };
  assert.match(text(await fileReadTool.run({ path: 'a.ts' }, ctx)), /export const a = 1/);

  await fileWriteTool.run({ path: 'nested/relative.txt', content: 'relative ok' }, ctx);
  assert.equal(await readFile(join(dir, 'nested', 'relative.txt'), 'utf8'), 'relative ok');

  const edit = text(await fileEditTool.run({ path: 'nested/relative.txt', old_string: 'ok', new_string: 'done' }, ctx));
  assert.match(edit, /已编辑/);
  assert.equal(await readFile(join(dir, 'nested', 'relative.txt'), 'utf8'), 'relative done');

  const globOut = text(await globTool.run({ pattern: 'sub/*.ts' }, ctx));
  assert.match(globOut, /sub\/b\.ts/);
  assert.match(text(await globTool.run({ pattern: '**/背景信息.md' }, ctx)), /健身\/背景信息\.md/);

  const grepOut = text(await grepTool.run({ pattern: 'TODO' }, ctx));
  assert.match(grepOut, /a\.ts:2/);
});

test('文件工具只在授权运行中读写当前用户目录', async () => {
  const threadRoot = join(dir, 'thread-user-files');
  const userRoot = join(dir, 'users', 'us_test');
  const otherRoot = join(dir, 'users', 'us_other');
  await Promise.all([mkdir(threadRoot, { recursive: true }), mkdir(userRoot, { recursive: true }), mkdir(otherRoot, { recursive: true })]);
  const settings = normalizeToolSettings({ workspaceRoot: threadRoot, sandbox: 'enforce' });
  const ownPath = join(userRoot, 'notes.md');
  const context = { scope: TEST_SCOPE, settings, userFiles: { source: userRoot, mountPath: userRoot } };
  assert.match((await runTool('file_write', { path: ownPath, content: '个人记录' }, context)).text, /已写入/);
  assert.equal((await runTool('file_read', { path: ownPath }, context)).text, '个人记录');
  assert.match((await runTool('glob', { path: userRoot, pattern: '*.md' }, context)).text, /\/users\/us_test\/notes\.md/);
  assert.match((await runTool('grep', { path: userRoot, pattern: '个人记录' }, context)).text, /\/users\/us_test\/notes\.md:1/);
  assert.match((await runTool('file_read', { path: ownPath }, { scope: TEST_SCOPE, settings })).text, /工具策略已阻止/);
  assert.match((await runTool('file_read', { path: join(otherRoot, 'notes.md') }, context)).text, /工具策略已阻止/);
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

function shellOutputWait(threadId: string, marker: string, signal: AbortSignal) {
  let resolveOutput!: () => void;
  let rejectOutput!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => { resolveOutput = resolve; rejectOutput = reject; });
  const dispose = () => {
    unsubscribe();
    signal.removeEventListener('abort', abort);
  };
  const unsubscribe = shellBus.subscribe(threadId, (event: AgentEvent) => {
    if (event.type !== 'shell_command_output' || !event.text.includes(marker)) return;
    dispose();
    resolveOutput();
  });
  const abort = () => { dispose(); rejectOutput(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  void promise.catch(() => undefined);
  return { promise, dispose };
}

test('shell_poll waits once for a real background command and reads beyond the first 200 log chunks', { timeout: 5000 }, async (t) => {
  const initialAbortListeners = getEventListeners(t.signal, 'abort').length;
  const thread = await shellStore.createThread(TEST_SCOPE);
  const settings = normalizeToolSettings({ workspaceRoot: dir, sandbox: 'off', shellUseHostPath: true });
  const session = await shellManager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const gate = join(dir, `${session.id}-gate`);
  const ready = shellOutputWait(thread.id, 'background-ready', t.signal);
  const ctx = { scope: TEST_SCOPE, settings, threadId: thread.id, abortSignal: t.signal };
  let commandId = '';
  try {
    const started = text(await shellExecTool.run({
      sessionId: session.id, wait: 'background',
      command: `printf 'background-ready\\n'; while [ ! -f '${gate}' ]; do sleep 0.01; done; printf 'background-final-output\\n'`,
    }, ctx));
    commandId = started.match(/不是完成）：([^\n]+)/)?.[1] ?? '';
    assert.ok(commandId);
    assert.match(started, /不是完成/);
    await ready.promise;
    // 已持久化历史超过一页；真实进程最后写入的输出必须仍出现在消费者结果中。
    for (let i = 0; i < 250; i++) await shellStore.appendShellCommandLog(TEST_SCOPE, commandId, 'stdout', `history-${i}\n`);
    let settled = false;
    const waiting = shellPollTool.run({ id: commandId }, ctx).then((result) => { settled = true; return text(result); });
    const snapshot = await shellManager.poll(TEST_SCOPE, commandId);
    assert.equal(snapshot.command?.status, 'running');
    assert.equal(settled, false, 'UI 即时查询不能等到命令结束');
    await writeFile(gate, 'release');
    const terminal = await waiting;
    assert.match(terminal, /status: succeeded/);
    assert.match(terminal, /background-final-output/);
    assert.doesNotMatch(terminal, /history-0\n/);
    assert.equal(getEventListeners(t.signal, 'abort').length, initialAbortListeners);
  } finally {
    ready.dispose();
    await writeFile(gate, 'release');
    if (commandId) await shellManager.kill(TEST_SCOPE, commandId, 'test_cleanup');
  }
});

test('foreground shell remains inside the tool after a tiny observation timeout', { timeout: 5000 }, async (t) => {
  const initialAbortListeners = getEventListeners(t.signal, 'abort').length;
  const thread = await shellStore.createThread(TEST_SCOPE);
  const settings = normalizeToolSettings({ workspaceRoot: dir, sandbox: 'off', shellUseHostPath: true });
  const session = await shellManager.reuseSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const gate = join(dir, `${session.id}-gate`);
  const ready = shellOutputWait(thread.id, 'foreground-ready', t.signal);
  let settled = false;
  const executing = shellTool.run({
    timeout_ms: 1,
    command: `printf 'foreground-ready\\n'; while [ ! -f '${gate}' ]; do sleep 0.01; done; printf 'foreground-final-output\\n'`,
  }, { scope: TEST_SCOPE, settings, threadId: thread.id, abortSignal: t.signal }).then((result) => { settled = true; return text(result); });
  try {
    await ready.promise;
    const snapshot = await shellManager.poll(TEST_SCOPE, session.id);
    assert.equal(snapshot.command?.status, 'running');
    assert.equal(settled, false);
    await writeFile(gate, 'release');
    assert.match(await executing, /status: succeeded[\s\S]*foreground-final-output/);
    assert.equal(getEventListeners(t.signal, 'abort').length, initialAbortListeners);
  } finally {
    ready.dispose();
    await writeFile(gate, 'release');
    const command = (await shellManager.poll(TEST_SCOPE, session.id)).command;
    if (command) await shellManager.kill(TEST_SCOPE, command.id, 'test_cleanup');
    await executing;
  }
});

test('shell wait propagates abort without killing an unrelated command and removes abort listeners', { timeout: 5000 }, async (t) => {
  const manager = shellManager;
  const thread = await shellStore.createThread(TEST_SCOPE);
  const settings = normalizeToolSettings({ workspaceRoot: dir, sandbox: 'off', shellUseHostPath: true });
  const session = await manager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const other = await manager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const gate = join(dir, `${session.id}-gate`);
  const controller = new AbortController();
  try {
    const target = await manager.exec({ scope: TEST_SCOPE, sessionId: session.id, command: `while [ ! -f '${gate}' ]; do sleep 0.01; done`, settings, context: { threadId: thread.id }, waitMode: 'background' });
    const unrelated = await manager.exec({ scope: TEST_SCOPE, sessionId: other.id, command: `while [ ! -f '${gate}' ]; do sleep 0.01; done; printf 'unrelated-final\\n'`, settings, context: { threadId: thread.id }, waitMode: 'background' });
    const waiting = runTool('shell_poll', { id: target.command.id }, { scope: TEST_SCOPE, settings, threadId: thread.id, abortSignal: controller.signal });
    const reason = new Error('用户取消本次等待');
    controller.abort(reason);
    await assert.rejects(waiting, (error) => error === reason);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal((await manager.poll(TEST_SCOPE, unrelated.command.id)).command?.status, 'running');
    await writeFile(gate, 'release');
    const terminal = await manager.wait(TEST_SCOPE, unrelated.command.id, 0, t.signal);
    assert.equal(terminal.command?.status, 'succeeded');
    assert.ok(terminal.logs.some((log) => log.chunk.includes('unrelated-final')));
  } finally {
    await writeFile(gate, 'release');
    for (const owned of [session, other]) {
      const command = (await manager.poll(TEST_SCOPE, owned.id)).command;
      if (command) {
        await manager.kill(TEST_SCOPE, command.id, 'test_cleanup');
        await manager.wait(TEST_SCOPE, command.id);
      }
    }
  }
});

test('manager shutdown interrupts model waiting but drains command terminal state and final output', { timeout: 5000 }, async (t) => {
  const initialAbortListeners = getEventListeners(t.signal, 'abort').length;
  const manager = new ShellManager();
  const thread = await shellStore.createThread(TEST_SCOPE);
  const settings = normalizeToolSettings({ workspaceRoot: dir, sandbox: 'off', shellUseHostPath: true });
  const session = await manager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const ready = shellOutputWait(thread.id, 'shutdown-ready', t.signal);
  try {
    const command = await manager.exec({
      scope: TEST_SCOPE, sessionId: session.id, settings, context: { threadId: thread.id }, waitMode: 'background',
      command: `trap 'printf "shutdown-final-output\\n"; exit 0' TERM; printf 'shutdown-ready\\n'; while :; do sleep 0.01; done`,
    });
    await ready.promise;
    const waiting = manager.wait(TEST_SCOPE, command.command.id, 0, t.signal);
    const shutdown = manager.shutdown();
    await assert.rejects(waiting, /服务正在关闭/);
    await shutdown;
    const final = await manager.poll(TEST_SCOPE, command.command.id);
    assert.equal(final.command?.status, 'killed');
    assert.equal(final.command?.attention, 'server_shutdown');
    assert.ok(final.logs.some((log) => log.chunk.includes('shutdown-final-output')));
    assert.equal(getEventListeners(t.signal, 'abort').length, initialAbortListeners);
  } finally {
    ready.dispose();
    await manager.shutdown();
  }
});

test('shell wait reports orphaned persisted commands and does not alter another thread', async () => {
  const manager = new ShellManager();
  const thread = await shellStore.createThread(TEST_SCOPE);
  const other = await shellStore.createThread(TEST_SCOPE);
  const settings = normalizeToolSettings({ workspaceRoot: dir });
  const session = await manager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const command = await shellStore.createShellCommand(TEST_SCOPE, {
    sessionId: session.id, actor: 'agent', command: 'interrupted command', cwd: dir, waitMode: 'background',
  });
  await assert.rejects(manager.wait(TEST_SCOPE, command.id, 0, undefined, other.id), /不属于当前 thread/);
  assert.equal((await shellStore.getShellCommand(TEST_SCOPE, command.id))?.status, 'queued');
  const terminal = await manager.wait(TEST_SCOPE, command.id, 0, undefined, thread.id);
  assert.equal(terminal.command?.status, 'orphaned');
  assert.match(terminal.command?.error ?? '', /无法连接/);
});

test('foreground shell_exec returns the real hard-timeout terminal result without another poll', { timeout: 5000 }, async (t) => {
  const initialAbortListeners = getEventListeners(t.signal, 'abort').length;
  const thread = await shellStore.createThread(TEST_SCOPE);
  const settings = normalizeToolSettings({ workspaceRoot: dir, sandbox: 'off', shellUseHostPath: true });
  const session = await shellManager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  try {
    // 验证平台上的真实命令硬超时与进程组终止，不使用模拟计时器替代子进程生命周期。
    const result = text(await shellExecTool.run({
      sessionId: session.id,
      wait: 'foreground',
      hard_timeout_ms: 200,
      command: `printf 'hard-timeout-started\\n'; while :; do sleep 0.01; done`,
    }, { scope: TEST_SCOPE, settings, threadId: thread.id, abortSignal: t.signal }));
    assert.match(result, /status: timed_out/);
    assert.match(result, /hard-timeout-started/);
    assert.doesNotMatch(result, /status: running/);
    const command = (await shellManager.poll(TEST_SCOPE, session.id)).command;
    assert.equal(command?.attention, 'hard_timeout');
    assert.ok(command?.ended_at);
    assert.equal(getEventListeners(t.signal, 'abort').length, initialAbortListeners);
  } finally {
    const command = (await shellManager.poll(TEST_SCOPE, session.id)).command;
    if (command) await shellManager.kill(TEST_SCOPE, command.id, 'test_cleanup');
  }
});

test('canceling a foreground shell_exec drains only its own command before propagating abort', { timeout: 5000 }, async (t) => {
  const thread = await shellStore.createThread(TEST_SCOPE);
  const settings = normalizeToolSettings({ workspaceRoot: dir, sandbox: 'off', shellUseHostPath: true });
  const session = await shellManager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const other = await shellManager.openSession({ scope: TEST_SCOPE, threadId: thread.id, settings });
  const gate = join(dir, `${other.id}-gate`);
  const controller = new AbortController();
  const ready = shellOutputWait(thread.id, 'cancel-foreground-ready', t.signal);
  const ctx = { scope: TEST_SCOPE, settings, threadId: thread.id, abortSignal: controller.signal };
  const unrelated = await shellManager.exec({
    scope: TEST_SCOPE, sessionId: other.id, settings, context: { threadId: thread.id }, waitMode: 'background',
    command: `while [ ! -f '${gate}' ]; do sleep 0.01; done; printf 'other-run-final\\n'`,
  });
  const executing = shellExecTool.run({
    sessionId: session.id, wait: 'foreground',
    command: `printf 'cancel-foreground-ready\\n'; while :; do sleep 0.01; done`,
  }, ctx).then(() => assert.fail('已取消的工具不应返回普通结果'), (error: unknown) => error);
  try {
    await ready.promise;
    const reason = new Error('仅取消本次前台命令');
    controller.abort(reason);
    assert.equal(await executing, reason);
    const canceled = (await shellManager.poll(TEST_SCOPE, session.id)).command;
    assert.equal(canceled?.status, 'killed');
    assert.equal(canceled?.attention, 'run_cancel');
    assert.ok(canceled?.ended_at);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal((await shellManager.poll(TEST_SCOPE, unrelated.command.id)).command?.status, 'running');
    await writeFile(gate, 'release');
    assert.equal((await shellManager.wait(TEST_SCOPE, unrelated.command.id)).command?.status, 'succeeded');
  } finally {
    ready.dispose();
    controller.abort(new Error('test_cleanup'));
    await executing;
    await writeFile(gate, 'release');
    await shellManager.kill(TEST_SCOPE, unrelated.command.id, 'test_cleanup');
    await shellManager.wait(TEST_SCOPE, unrelated.command.id);
  }
});
