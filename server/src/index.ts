import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { runTraceWriter, startTraceRetention, stopTraceRetention } from './observability/runTrace.js';
import { isAcceptingNewRunExecutions, stopAcceptingNewRunExecutions, waitForAllRunExecutions } from './agent/executionControl.js';

// Register the tracer provider before the server handles any request. The AI SDK
// and our executor read the global tracer at call time, so this is sufficient
// (we use manual spans + experimental_telemetry, not import-time patching).
initTelemetry();
startTraceRetention();

import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { api } from './api/http.js';
import { attachWebSocket } from './api/ws.js';
import { assertJwtSecretConfigured } from './auth/jwt.js';
import { runBootstrap } from './auth/bootstrap.js';
import { describeShellSandbox } from './tools/sandbox.js';
import { getSystemToolSettings } from './settings.js';
import { recoverInterruptedRuns } from './agent/recovery.js';
import { startDatasourceLeaseReconciler } from './datasources/reconciler.js';
import { shellManager } from './shell/manager.js';
import { externalArtifactStorage } from './external/artifactStorage.js';
import { listArtifactStorageKeys } from './external/repository.js';
import { mountWebApp } from './web/static.js';
import { materializeLegacySpaceConfigs } from './spaces/materialize.js';
import { startStorageUsageScheduler } from './usage/service.js';

const app = express();
assertJwtSecretConfigured();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
let acceptingUserRequests = true;
let activeHttpRequests = 0;
let resolveHttpRequestsDrained: (() => void) | null = null;
app.use((req, res, next) => {
  if (!acceptingUserRequests || !isAcceptingNewRunExecutions()) {
    res.status(503).json({ error: '服务正在关闭' });
    return;
  }
  activeHttpRequests += 1;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    activeHttpRequests -= 1;
    if (activeHttpRequests === 0) resolveHttpRequestsDrained?.();
  };
  res.once('finish', complete);
  res.once('close', complete);
  next();
});
app.use('/api', api);
const webDist = mountWebApp(app, process.env.RUNFORGE_WEB_DIST);

const server = createServer(app);
attachWebSocket(server);
const upgradedSockets = new Set<import('node:stream').Duplex>();
server.on('upgrade', (_request, socket) => {
  upgradedSockets.add(socket);
  socket.once('close', () => upgradedSockets.delete(socket));
});

// bootstrap 必须在 listen 之前完成:不能在没有可登录账号的状态下开始接受请求
// (docs/multi-tenancy-design.md §4)。不同于下面 listen 回调里那些 fire-and-forget
// 的恢复逻辑，这一步会阻塞启动。
await runBootstrap();
const materializedSpaces = await materializeLegacySpaceConfigs();
if (materializedSpaces > 0) console.log(`   Materialized legacy space configs: ${materializedSpaces}`);
try {
  const removed = await externalArtifactStorage.reconcile(await listArtifactStorageKeys());
  if (removed > 0) console.log(`   Removed orphaned external artifacts: ${removed}`);
} catch (error) {
  console.warn(`   External artifact reconciliation skipped: ${(error as Error).message}`);
}
const stopDatasourceLeaseReconciler = startDatasourceLeaseReconciler();
startStorageUsageScheduler();

const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;

let recoveryTask: Promise<number> | null = null;
server.listen(config.port, config.host, () => {
  console.log(`🚀 RunForge server listening on http://${displayHost}:${config.port}`);
  if (webDist) console.log(`   Web: ${webDist}`);
  console.log(`   WebSocket: ws://${displayHost}:${config.port}/ws?runId=<id>`);
  void getSystemToolSettings().then((settings) => {
    console.log(
      `   Tool sandbox: ${settings.sandbox}` +
        (settings.sandbox === 'enforce'
          ? ` (workspace 基础目录: ${settings.workspaceRoot}; 会话按 space/c/thread 隔离, shell: ${describeShellSandbox({
              policyMode: settings.sandbox,
              backend: settings.sandboxBackend,
              workspaceRoot: settings.workspaceRoot,
              useHostPath: settings.shellUseHostPath,
              shareNet: settings.network === 'enabled',
            })})`
          : ''),
    );
  });
  if (isAcceptingNewRunExecutions()) {
    recoveryTask = recoverInterruptedRuns();
    void recoveryTask.then((count) => {
      if (count > 0) console.log(`   Recovered interrupted runs: ${count}`);
    });
  }
  void shellManager.markInterruptedCommandsOrphaned()
    .then((count) => {
      if (count > 0) console.log(`   Marked orphaned shell commands: ${count}`);
    })
    .catch((err) => {
      console.warn(`   Shell command recovery skipped: ${(err as Error).message}`);
    });
});

let shutdownPromise: Promise<void> | null = null;
async function waitForHttpRequests(): Promise<void> {
  while (activeHttpRequests > 0) {
    await new Promise<void>((resolve) => {
      resolveHttpRequestsDrained = resolve;
    });
    resolveHttpRequestsDrained = null;
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  acceptingUserRequests = false;
  stopAcceptingNewRunExecutions();
  shellManager.stopAcceptingCommands();
  stopTraceRetention();
  stopDatasourceLeaseReconciler();
  shutdownPromise = (async () => {
    const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });

    try {
      // shell 停止接纳后立刻终止命令，避免前台 executor 等待 shell 时阻塞关闭。
      const settled = await Promise.allSettled([
        waitForHttpRequests(),
        waitForAllRunExecutions(),
        shellManager.shutdown(),
        recoveryTask ?? Promise.resolve(0),
      ]);
      for (const socket of upgradedSockets) socket.destroy();
      server.closeAllConnections();
      await serverClosed;
      await runTraceWriter.flushAll();
      await shutdownTelemetry();
      const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, '服务关闭时有 HTTP、run 或 shell 资源未能完整结束');
      console.log(`收到 ${signal}，服务已完成关闭与日志写入。`);
      process.exit(0);
    } catch (error) {
      console.error(`服务关闭失败：${(error as Error).stack ?? String(error)}`);
      await shutdownTelemetry().catch((telemetryError) => {
        console.error(`关闭遥测失败：${(telemetryError as Error).message}`);
      });
      process.exit(1);
    }
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
