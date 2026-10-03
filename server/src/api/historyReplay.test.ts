import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryStep } from '@runforge/contracts';
import { completedHistoryThrough, completedHistoryThroughStates } from '@runforge/contracts';
import { selectInitialHistoryStepIndices } from './historyReplay.js';

function historyStep(idx: number, calls: string[] = [], results: string[] = []): HistoryStep {
  return {
    id: `step-${idx}`,
    idx,
    assistantMessageId: idx,
    result: {
      reasoning: null,
      output: null,
      usage: null,
      streamStats: null,
      finishReason: calls.length ? 'tool-calls' : 'stop',
      rawFinishReason: null,
      startedAt: null,
      reasoningStartedAt: null,
      endedAt: '2026-09-30T00:00:00.000Z',
      durationMs: null,
      toolCalls: calls.map((id) => ({ id, name: 'tool', args: {} })),
    },
    toolResults: results.map((toolCallId) => ({
      toolCallId,
      content: '完成结果',
      createdAt: '2026-09-30T00:00:01.000Z',
    })),
    createdAt: '2026-09-30T00:00:00.000Z',
    completedAt: '2026-09-30T00:00:00.000Z',
  };
}

test('安全游标只越过工具结果齐全的step，并允许失败step编号空缺', () => {
  assert.equal(completedHistoryThrough([
    historyStep(1),
    historyStep(3, ['call-a', 'call-b'], ['call-a', 'call-b']),
  ]), 3);
  assert.equal(completedHistoryThrough([
    historyStep(1),
    historyStep(2, ['call-a', 'call-b'], ['call-a']),
    historyStep(3),
  ]), 1);
  assert.equal(completedHistoryThroughStates([
    { idx: 4, complete: false },
    { idx: 5, complete: true },
  ], 3), 3);
});

test('实时完成通知先于旧历史查询返回时不再次回放该step', () => {
  const announced = new Map<number, boolean>([[1, true]]);
  assert.deepEqual(
    selectInitialHistoryStepIndices([{ idx: 1 }, { idx: 2 }, { idx: 3 }], 2, announced),
    [3],
  );
});
