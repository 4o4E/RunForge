import { EventEmitter } from 'node:events';
import type { AgentEvent } from './types.js';

/**
 * In-process pub/sub for live run events. The executor publishes; the WebSocket
 * layer subscribes per runId. No external broker — single-process by design.
 */
class RunBus extends EventEmitter {
  publish(runId: string, event: AgentEvent): void {
    this.emit(runId, event);
  }
  subscribe(runId: string, handler: (e: AgentEvent) => void): () => void {
    this.on(runId, handler);
    return () => this.off(runId, handler);
  }
}

export const runBus = new RunBus();
runBus.setMaxListeners(0);
