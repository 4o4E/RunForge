import { EventEmitter } from 'node:events';
import type { AgentEvent } from './types.js';
import type { HistoryStep, LiveStepSnapshot } from '@runforge/contracts';

export interface LiveRunEvent {
  cursor: number;
  event: AgentEvent;
}

/**
 * In-process pub/sub for live run events. The executor publishes; the WebSocket
 * layer subscribes per runId. No external broker — single-process by design.
 */
class RunBus extends EventEmitter {
  private readonly buffers = new Map<string, LiveRunEvent[]>();
  private readonly cursors = new Map<string, number>();
  private readonly activeSteps = new Map<string, number>();

  publish(runId: string, event: AgentEvent): number {
    if (event.type === 'step_start') this.activeSteps.set(runId, event.step);
    const cursor = (this.cursors.get(runId) ?? 0) + 1;
    this.cursors.set(runId, cursor);
    const row = { cursor, event };
    const rows = this.buffers.get(runId);
    if (rows) rows.push(row);
    else this.buffers.set(runId, [row]);
    this.emit(runId, event);
    this.emit(`${runId}:rows`, row);
    return cursor;
  }
  subscribe(runId: string, handler: (e: AgentEvent) => void): () => void {
    this.on(runId, handler);
    return () => this.off(runId, handler);
  }

  subscribeRows(runId: string, handler: (event: LiveRunEvent) => void): () => void {
    const key = `${runId}:rows`;
    this.on(key, handler);
    return () => this.off(key, handler);
  }

  eventsAfter(runId: string, cursor: number): LiveRunEvent[] {
    return (this.buffers.get(runId) ?? []).filter((row) => row.cursor > cursor);
  }

  currentCursor(runId: string): number {
    return this.cursors.get(runId) ?? 0;
  }

  currentStepSnapshot(runId: string): LiveStepSnapshot | null {
    const rows = this.buffers.get(runId) ?? [];
    const step = this.activeSteps.get(runId);
    if (step === undefined) return null;
    return {
      step,
      events: rows.filter((row) => 'step' in row.event && row.event.step === step).map((row) => row.event),
    };
  }

  publishStepCompleted(runId: string, step: HistoryStep): void {
    if (this.activeSteps.get(runId) === step.idx) this.activeSteps.delete(runId);
    this.emit(`${runId}:step-completed`, step);
  }

  subscribeStepCompleted(runId: string, handler: (step: HistoryStep) => void): () => void {
    const key = `${runId}:step-completed`;
    this.on(key, handler);
    return () => this.off(key, handler);
  }

  subscribeSettled(runId: string, handler: () => void): () => void {
    const key = `${runId}:settled`;
    this.on(key, handler);
    return () => this.off(key, handler);
  }

  /** 上一个 step 已保存聚合结果后，原始分片不再占用内存。 */
  clearBeforeStep(runId: string, step: number): void {
    this.activeSteps.set(runId, step);
    const rows = this.buffers.get(runId);
    if (!rows) return;
    this.buffers.set(runId, rows.filter((row) => !('step' in row.event) || row.event.step >= step));
  }

  clear(runId: string): void {
    this.emit(`${runId}:settled`);
    this.buffers.delete(runId);
    this.cursors.delete(runId);
    this.activeSteps.delete(runId);
  }
}

export const runBus = new RunBus();
runBus.setMaxListeners(0);
