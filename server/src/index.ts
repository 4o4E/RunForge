import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { api } from './api/http.js';
import { attachWebSocket } from './api/ws.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', api);

const server = createServer(app);
attachWebSocket(server);

server.listen(config.port, () => {
  console.log(`🚀 my-agent server listening on http://localhost:${config.port}`);
  console.log(`   WebSocket: ws://localhost:${config.port}/ws?runId=<id>`);
});
