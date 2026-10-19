import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRow, Scope } from '../store/types.js';
import { agentEventSchema, type AgentEvent } from '@runforge/contracts';
import { shellBus } from '../shell/bus.js';

process.env.STORE = 'postgres';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tenantId = `shell-shutdown-${suffix}`;
const workspaceRoot = await mkdtemp(join(tmpdir(), `runforge-shell-${suffix}-`));
const traceDirectory = await mkdtemp(join(tmpdir(), `runforge-shell-trace-${suffix}-`));
process.env.RUNFORGE_TRACE_DIR = traceDirectory;

const [storeModule, prismaModule, poolModule, settingsModule, managerModule, traceModule] = await Promise.all([
  import('../store/index.js'),
  import('../db/prisma.js'),
  import('../db/pool.js'),
  import('../settings.js'),
  import('../shell/manager.js'),
  import('../observability/runTrace.js'),
]);

const { store } = storeModule;
const { prisma } = prismaModule;
const { pool } = poolModule;
const { normalizeToolSettings } = settingsModule;
const { ShellManager } = managerModule;
const { runTraceWriter } = traceModule;
const managers: InstanceType<typeof ShellManager>[] = [];
let tenantCreated = false;
let run: RunRow | null = null;
let scope: Scope | null = null;

async function waitForCommand(scopeValue: Scope, sessionId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [command] = await store.listShellCommandsBySession(scopeValue, sessionId, 1);
    if (command) return command;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`10 秒内没有在 session ${sessionId} 创建 shell command`);
}

async function waitForLog(scopeValue: Scope, commandId: string, marker: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const logs = await store.getShellCommandLogs(scopeValue, commandId);
    if (logs.some((log) => log.chunk.includes(marker))) return logs;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`10 秒内没有持久化 shell 输出标记 ${marker}`);
}

try {
  const provisioned = await store.createTenantWithOwner({
    id: tenantId,
    name: `Shell shutdown verification ${suffix}`,
    ownerEmail: `shell-shutdown-${suffix}@tenant.test`,
    ownerPasswordHash: 'verification-only',
    settingsTemplate: [],
  });
  tenantCreated = true;
  scope = { tenantId, userId: provisioned.owner.id };
  const thread = await store.createThread(scope, 'Shell shutdown verification', {
    spaceId: provisioned.defaultSpace.id,
  });
  run = await store.createRun(scope, thread.id, 'Shell shutdown verification');

  const settings = normalizeToolSettings({
    workspaceRoot,
    sandbox: 'off',
    sandboxBackend: 'none',
    shellUseHostPath: true,
  });

  // 真实 PG 返回 Date/bigint 字符串，必须在消费者看到事件之前转换。
  const typedSession = await store.createShellSession(scope, {
    threadId: thread.id,
    name: 'PG row boundary',
    owner: 'agent',
    workspaceRoot,
    backend: 'host',
  });
  const assertSessionTimes = (session: typeof typedSession) => {
    assert.equal(typeof session.created_at, 'string');
    assert.equal(typeof session.updated_at, 'string');
    assert.equal(session.deleted_at, null);
  };
  assertSessionTimes(typedSession);
  assertSessionTimes((await store.getShellSession(scope, typedSession.id))!);
  for (const session of await store.listShellSessions(scope, thread.id)) assertSessionTimes(session);
  for (const session of await store.listShellSessions(scope, thread.id, workspaceRoot)) assertSessionTimes(session);

  const queued = await store.createShellCommand(scope, {
    sessionId: typedSession.id,
    runId: run.id,
    actor: 'agent',
    command: 'row conversion',
    cwd: workspaceRoot,
    waitMode: 'foreground',
    softTimeoutMs: 1000,
    hardTimeoutMs: 2000,
    softTimeoutAt: new Date(Date.now() + 1000).toISOString(),
    hardTimeoutAt: new Date(Date.now() + 2000).toISOString(),
  });
  const assertCommandTimes = (command: typeof queued) => {
    for (const key of ['started_at', 'updated_at'] as const) assert.equal(typeof command[key], 'string');
    for (const key of ['ended_at', 'soft_timeout_at', 'hard_timeout_at', 'last_output_at'] as const) {
      assert.ok(command[key] === null || typeof command[key] === 'string', key);
    }
    assert.ok(Number.isSafeInteger(command.output_bytes));
  };
  assertCommandTimes(queued);
  assert.equal(queued.ended_at, null);
  assert.equal(typeof queued.soft_timeout_at, 'string');
  assert.equal(typeof queued.hard_timeout_at, 'string');
  assertCommandTimes((await store.listRunningShellCommandsUnscoped()).find((command) => command.id === queued.id)!);
  await store.updateShellCommand(scope, queued.id, { status: 'running' });
  assertCommandTimes((await store.listRunningShellCommandsByRun(scope, run.id)).find((command) => command.id === queued.id)!);
  for (let seq = 1; seq <= 12; seq++) {
    const log = await store.appendShellCommandLog(scope, queued.id, 'stdout', `line-${seq}\n`);
    assert.equal(log.seq, seq);
    assert.ok(Number.isSafeInteger(log.id));
    assert.equal(typeof log.created_at, 'string');
  }
  const page = await store.getShellCommandLogs(scope, queued.id, 8, 3);
  assert.deepEqual(page.map((log) => log.seq), [9, 10, 11]);
  for (const log of page) {
    assert.ok(Number.isSafeInteger(log.id));
    assert.equal(typeof log.created_at, 'string');
  }
  await store.updateShellCommand(scope, queued.id, {
    status: 'succeeded',
    exit_code: 0,
    ended_at: new Date().toISOString(),
    last_output_at: new Date().toISOString(),
    output_bytes: 123,
  });
  const persisted = (await store.getShellCommand(scope, queued.id))!;
  assertCommandTimes(persisted);
  assert.equal(typeof persisted.ended_at, 'string');
  assert.equal(typeof persisted.last_output_at, 'string');
  assert.equal(persisted.output_bytes, 123);
  for (const command of await store.listShellCommandsBySession(scope, typedSession.id)) assertCommandTimes(command);

  // 超安全整数必须报错，不能在游标或输出计数上静默损失精度。
  await prisma.shell_commands.update({ where: { id: queued.id }, data: { output_bytes: 9007199254740992n } });
  await assert.rejects(store.getShellCommand(scope, queued.id), /安全整数范围/);
  await prisma.shell_commands.update({ where: { id: queued.id }, data: { output_bytes: 123n } });
  await prisma.shell_command_logs.create({
    data: { command_id: queued.id, seq: 9007199254740992n, stream: 'stdout', chunk: 'unsafe' },
  });
  await assert.rejects(store.getShellCommandLogs(scope, queued.id), /安全整数范围/);
  await assert.rejects(store.appendShellCommandLog(scope, queued.id, 'stdout', 'unsafe-next'), /安全整数范围/);
  await prisma.shell_command_logs.deleteMany({ where: { command_id: queued.id, seq: { gt: 12n } } });
  const unsafeIdLog = await prisma.shell_command_logs.create({
    data: { id: 9007199254740992n, command_id: queued.id, seq: 13n, stream: 'stdout', chunk: 'unsafe-id' },
  });
  await assert.rejects(store.getShellCommandLogs(scope, queued.id), /安全整数范围/);
  await prisma.shell_command_logs.delete({ where: { id: unsafeIdLog.id } });

  const rowManager = new ShellManager();
  managers.push(rowManager);
  const events: AgentEvent[] = [];
  const unsubscribe = shellBus.subscribe(thread.id, (event) => events.push(event));
  try {
    const result = await rowManager.exec({
      scope,
      sessionId: typedSession.id,
      command: "printf 'pg-consumer-stdout\\n'; printf 'pg-consumer-stderr\\n' >&2",
      settings,
      context: { threadId: thread.id, runId: run.id, step: 1 },
      waitMode: 'foreground',
      waitTimeoutMs: 30_000,
    });
    assert.equal(result.command.status, 'succeeded');
    assert.equal(result.command.exit_code, 0);
    assert.equal(result.timedOutWaiting, false);
    assert.match(result.tail, /pg-consumer-stdout/);
    assert.match(result.tail, /pg-consumer-stderr/);
    assertCommandTimes(result.command);
    const commandEvents = events.filter((event) => 'commandId' in event && event.commandId === result.command.id);
    assert.ok(commandEvents.some((event) => event.type === 'shell_command_started'));
    assert.ok(commandEvents.some((event) => event.type === 'shell_command_output'));
    assert.ok(commandEvents.some((event) => event.type === 'shell_command_finished'));
    for (const event of commandEvents) agentEventSchema.parse(event);
  } finally {
    unsubscribe();
  }

  const backgroundSession = await store.createShellSession(scope, {
    threadId: thread.id,
    name: 'Background shutdown race',
    owner: 'agent',
    workspaceRoot,
    backend: 'host',
  });
  const backgroundManager = new ShellManager();
  managers.push(backgroundManager);
  const backgroundExecution = backgroundManager.exec({
    scope,
    sessionId: backgroundSession.id,
    command: `printf 'background-started\\n'; sleep 30; printf 'background-finished\\n' > '${join(workspaceRoot, 'background-finished')}'`,
    settings,
    context: { threadId: thread.id, runId: run.id, step: 1 },
    waitMode: 'background',
  });
  const backgroundShutdown = backgroundManager.shutdown();
  const [backgroundResult] = await Promise.all([backgroundExecution, backgroundShutdown]);
  const backgroundCommand = await store.getShellCommand(scope, backgroundResult.command.id);
  assert.equal(backgroundCommand?.status, 'killed', 'startup-race 后台命令必须在关闭完成前终止');
  await assert.rejects(stat(join(workspaceRoot, 'background-finished')));

  const foregroundSession = await store.createShellSession(scope, {
    threadId: thread.id,
    name: 'Foreground shutdown',
    owner: 'agent',
    workspaceRoot,
    backend: 'host',
  });
  const foregroundManager = new ShellManager();
  managers.push(foregroundManager);
  const foregroundExecution = foregroundManager.exec({
    scope,
    sessionId: foregroundSession.id,
    command: `printf 'foreground-ready\\n'; trap 'printf "foreground-final-output\\n"; exit 0' TERM; while :; do sleep 1; done; printf 'foreground-after\\n' > '${join(workspaceRoot, 'foreground-after')}'`,
    settings,
    context: { threadId: thread.id, runId: run.id, step: 2 },
    waitMode: 'foreground',
    waitTimeoutMs: 120_000,
  });
  const foregroundCommand = await waitForCommand(scope, foregroundSession.id);
  await waitForLog(scope, foregroundCommand.id, 'foreground-ready');

  // 关闭必须先终止 shell，前台 exec 才会结束；这两个等待同时进行以检验关闭顺序。
  const foregroundShutdown = foregroundManager.shutdown();
  const [foregroundResult] = await Promise.all([foregroundExecution, foregroundShutdown]);
  const foregroundFinal = await store.getShellCommand(scope, foregroundCommand.id);
  const foregroundLogs = await store.getShellCommandLogs(scope, foregroundCommand.id);
  assert.equal(foregroundResult.command.status, 'killed');
  assert.equal(foregroundFinal?.status, 'killed');
  assert.ok(foregroundFinal?.ended_at);
  assert.ok(foregroundLogs.some((log) => log.chunk.includes('foreground-ready')));
  assert.ok(foregroundLogs.some((log) => log.chunk.includes('foreground-final-output')));
  await assert.rejects(stat(join(workspaceRoot, 'foreground-after')));

  await assert.rejects(
    foregroundManager.exec({
      scope,
      sessionId: foregroundSession.id,
      command: 'true',
      settings,
      context: { threadId: thread.id, runId: run.id, step: 2 },
      waitMode: 'background',
    }),
    /服务正在关闭/,
  );

  await runTraceWriter.flushAll();
  const runTraceDirectory = join(traceDirectory, run.id);
  const traceFiles = await readdir(runTraceDirectory);
  const traceRecords = (await Promise.all(traceFiles.map(async (file) => (
    (await readFile(join(runTraceDirectory, file), 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; event?: Record<string, unknown> })
  )))).flat();
  const foregroundEvents = traceRecords
    .filter((record) => record.kind === 'agent_event' && record.event?.commandId === foregroundCommand.id)
    .map((record) => record.event!);
  assert.ok(foregroundEvents.some((event) => event.type === 'shell_command_output' && String(event.text).includes('foreground-ready')));
  assert.ok(foregroundEvents.some((event) => event.type === 'shell_command_output' && String(event.text).includes('foreground-final-output')));
  assert.ok(foregroundEvents.some((event) => event.type === 'shell_command_finished' && event.status === 'killed'));

  console.log(JSON.stringify({
    ok: true,
    backgroundCommandStatus: backgroundCommand?.status,
    foregroundCommandStatus: foregroundFinal?.status,
    foregroundOutputChunks: foregroundLogs.length,
    foregroundTraceEventTypes: [...new Set(foregroundEvents.map((event) => event.type))],
  }));
} finally {
  const cleanupFailures: unknown[] = [];
  const cleanup = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push(error);
    }
  };
  await Promise.all(managers.map((manager) => cleanup(() => manager.shutdown())));
  if (run && scope) await cleanup(() => store.setRunStatus(scope!, run!.id, 'canceled'));
  if (tenantCreated) await cleanup(() => store.deleteTenant(tenantId));
  await cleanup(() => runTraceWriter.flushAll());
  await cleanup(() => prisma.$disconnect());
  await cleanup(() => pool.end());
  await cleanup(() => rm(workspaceRoot, { recursive: true, force: true }));
  await cleanup(() => rm(traceDirectory, { recursive: true, force: true }));
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'shell shutdown 集成验证清理失败');
}
