import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { runBus } from '../agent/bus.js';
import { store } from '../store/index.js';
import type { AgentEvent } from '../agent/types.js';

/**
 * WebSocket endpoint: ws://host/ws?runId=<id>
 * Replays any events already persisted, then streams live events for that run.
 */
export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (socket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const runId = url.searchParams.get('runId');
    if (!runId) {
      socket.close(1008, 'runId query param required');
      return;
    }

    const send = (event: AgentEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    // Replay history so a late subscriber still sees the full run.
    try {
      for (const e of await store.getEvents(runId)) send(e);
    } catch {
      /* ignore replay errors */
    }

    const unsubscribe = runBus.subscribe(runId, (event) => {
      send(event);
      if (event.type === 'final' || event.type === 'error') {
        socket.close(1000, 'run complete');
      }
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
