import { initTelemetry } from './telemetry.js';

// Register the tracer provider before the server handles any request. The AI SDK
// and our executor read the global tracer at call time, so this is sufficient
// (we use manual spans + experimental_telemetry, not import-time patching).
initTelemetry();

import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { api } from './api/http.js';
import { attachWebSocket } from './api/ws.js';
import { assertJwtSecretConfigured } from './auth/jwt.js';
import { runBootstrap } from './auth/bootstrap.js';
import { describeShellSandbox } from './tools/sandbox.js';
import { getToolSettings } from './settings.js';
import { recoverInterruptedRuns } from './agent/recovery.js';
import { startDatasourceLeaseReconciler } from './datasources/reconciler.js';
import { shellManager } from './shell/manager.js';

const app = express();
assertJwtSecretConfigured();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', api);

const server = createServer(app);
attachWebSocket(server);

// bootstrap 必须在 listen 之前完成:不能在没有可登录账号的状态下开始接受请求
// (docs/multi-tenancy-design.md §4)。不同于下面 listen 回调里那些 fire-and-forget
// 的恢复逻辑，这一步会阻塞启动。
await runBootstrap();
startDatasourceLeaseReconciler();

const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;

server.listen(config.port, config.host, () => {
  console.log(`🚀 RunForge server listening on http://${displayHost}:${config.port}`);
  console.log(`   WebSocket: ws://${displayHost}:${config.port}/ws?runId=<id>`);
  void getToolSettings({ tenantId: 'default' }).then((settings) => {
    console.log(
      `   Tool sandbox: ${settings.sandbox}` +
        (settings.sandbox === 'enforce'
          ? ` (workspace: ${settings.workspaceRoot}, shell: ${describeShellSandbox({
              policyMode: settings.sandbox,
              backend: settings.sandboxBackend,
              workspaceRoot: settings.workspaceRoot,
              allowCommands: settings.shellAllowCommands,
              useHostPath: settings.shellUseHostPath,
              shareNet: settings.network === 'enabled',
            })})`
          : ''),
    );
  });
  void recoverInterruptedRuns().then((count) => {
    if (count > 0) console.log(`   Recovered interrupted runs: ${count}`);
  });
  void shellManager.markInterruptedCommandsOrphaned()
    .then((count) => {
      if (count > 0) console.log(`   Marked orphaned shell commands: ${count}`);
    })
    .catch((err) => {
      console.warn(`   Shell command recovery skipped: ${(err as Error).message}`);
    });
});
