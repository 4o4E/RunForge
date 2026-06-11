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
import { describeShellSandbox } from './tools/sandbox.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', api);

const server = createServer(app);
attachWebSocket(server);

const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;

server.listen(config.port, config.host, () => {
  console.log(`🚀 my-agent server listening on http://${displayHost}:${config.port}`);
  console.log(`   WebSocket: ws://${displayHost}:${config.port}/ws?runId=<id>`);
  console.log(
    `   Tool sandbox: ${config.tools.sandbox}` +
      (config.tools.sandbox === 'enforce'
        ? ` (workspace: ${config.tools.workspaceRoot}, shell: ${describeShellSandbox({
            policyMode: config.tools.sandbox,
            backend: config.tools.sandboxBackend,
            workspaceRoot: config.tools.workspaceRoot,
            allowCommands: config.tools.shellAllowCommands,
            shareNet: config.tools.shellShareNet,
          })})`
        : ''),
  );
});
