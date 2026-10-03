import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRow, Scope } from '../store/types.js';

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
