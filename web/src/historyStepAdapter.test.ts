import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryStep, ThreadContextMessage, ThreadHistoryRun } from '@runforge/contracts';
import { runsToUiMessages } from './history.js';
import { historyStepEvents, historyStepToEvents } from './historyStepAdapter.js';

function step(
  idx: number,
  input: Pick<NonNullable<HistoryStep['result']>, 'reasoning' | 'output' | 'toolCalls'>,
  toolResults: HistoryStep['toolResults'] = [],
  assistantMessageId: number | null = idx * 10,
): HistoryStep {
  return {
    id: `step-${idx}`,
    idx,
    assistantMessageId,
    result: {
      reasoning: input.reasoning,
      output: input.output,
      usage: null,
      streamStats: null,
      finishReason: input.toolCalls.length ? 'tool-calls' : 'stop',
      rawFinishReason: null,
      startedAt: null,
      reasoningStartedAt: null,
      endedAt: `2026-09-30T00:00:0${idx}.000Z`,
      durationMs: null,
      toolCalls: input.toolCalls,
    },
    toolResults,
    createdAt: `2026-09-30T00:00:0${idx}.000Z`,
    completedAt: `2026-09-30T00:00:0${idx}.000Z`,
  };
}

function userMessage(id: number, content: string, createdAt: string): ThreadContextMessage {
  return {
    id,
    run_id: 'run-history',
    step_id: null,
    role: 'user',
    tool_calls: [],
    tool_call_id: null,
    collapsed: null,
    summary_of: [],
    content_chars: content.length,
    content,
    created_at: createdAt,
  };
}

function run(steps: HistoryStep[], overrides: Partial<ThreadHistoryRun> = {}): ThreadHistoryRun {
  return {
    id: 'run-history',
    thread_id: 'thread-history',
    parent_run_id: null,
    status: 'done',
    input: '开始任务',
    model_ref: null,
    output: '最终结果',
    error: null,
    goal_state: null,
    pending_interaction: null,
    created_at: '2026-09-30T00:00:00.000Z',
    updated_at: '2026-09-30T00:00:05.000Z',
    steps,
    ...overrides,
  };
}

test('step聚合恢复正文、推理、工具结果，最终输出只显示一次', () => {
  const history = run([
    step(1, {
      reasoning: '先读取信息',
      output: null,
      toolCalls: [{ id: 'call-read', name: 'file_read', args: { path: 'notes.md' } }],
    }, [{ toolCallId: 'call-read', content: '文件内容', createdAt: '2026-09-30T00:00:01.500Z' }]),
    step(2, { reasoning: '整理完成', output: '最终结果', toolCalls: [] }),
  ]);
  const events = historyStepEvents(history, []);
  const messages = runsToUiMessages([{ ...history, events, completedThrough: 2 }], history.id);
  const assistantMessages = messages.filter((message) => message.role === 'assistant');

  assert.equal(assistantMessages.length, 1);
  const parts = assistantMessages[0].parts;
  assert.equal(parts.filter((part) => part.type === 'text' && part.text === '最终结果').length, 1);
  assert.equal(parts.filter((part) => part.type === 'data-final-output').length, 1);
  assert.deepEqual(parts.filter((part) => part.type === 'reasoning').map((part) => part.text), ['先读取信息', '整理完成']);
  const tool = parts.find((part) => part.type === 'dynamic-tool' && part.toolCallId === 'call-read');
  assert.ok(tool && tool.type === 'dynamic-tool');
  assert.deepEqual(tool.input, { path: 'notes.md' });
  assert.equal(tool.output, '文件内容');
});

test('刷新历史会恢复ask_user问题，并把后续user_answer留在问题所在助手消息', () => {
  const history = run([
    step(1, {
      reasoning: '需要确认下一步',
      output: null,
      toolCalls: [{
        id: 'call-ask',
        name: 'ask_user',
        args: { question: '是否继续？', mode: 'single', options: [{ id: 'yes', label: '继续' }] },
      }],
    }, [{ toolCallId: 'call-ask', content: '已等待用户回答', createdAt: '2026-09-30T00:00:01.500Z' }]),
    step(2, { reasoning: '根据回答继续', output: '已继续完成', toolCalls: [] }),
  ], { output: '已继续完成' });
  const messages = [
    userMessage(1, '开始任务', '2026-09-30T00:00:00.000Z'),
    userMessage(11, `用户回答：${JSON.stringify({
      mode: 'single',
      selected: [{ id: 'yes', label: '继续' }],
      customOptions: ['自定义范围'],
      text: '',
      note: '先确认数据',
      usedRecommended: false,
    })}`, '2026-09-30T00:00:01.750Z'),
  ];
  const events = historyStepEvents(history, messages);
  const answer = events.find((event) => event.type === 'user_answer');
  assert.ok(answer && answer.type === 'user_answer');
  assert.equal(answer.step, 2);
  assert.deepEqual(answer.answer.selected, [{ id: 'yes', label: '继续' }]);
  assert.deepEqual(answer.answer.customOptions, ['自定义范围']);
  assert.equal(answer.answer.note, '先确认数据');
  const uiMessages = runsToUiMessages([{ ...history, events, completedThrough: 2 }], history.id, [], messages);

  assert.deepEqual(uiMessages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(uiMessages[1].parts.some((part) => part.type === 'data-ask-user-question'), true);
  assert.equal(uiMessages[1].parts.some((part) => part.type === 'data-ask-user-answer'), true);
  assert.equal(uiMessages[2].parts.find((part) => part.type === 'text')?.text, messages[1].content);
  assert.equal(uiMessages[3].parts.some((part) => part.type === 'data-final-output'), true);
});

test('普通历史用户消息按消息编号插入step边界，不伪装成ask_user回答', () => {
  const history = run([
    step(1, { reasoning: '已读取文件', output: null, toolCalls: [] }),
    step(2, { reasoning: '处理补充要求', output: '完成', toolCalls: [] }),
  ]);
  const messages = [
    userMessage(1, '开始任务', '2026-09-30T00:00:00.000Z'),
    // 时间早于 step.createdAt，顺序仍由持久化消息编号决定。
    userMessage(11, '请只处理其中一项', '2026-09-29T23:59:59.000Z'),
  ];
  const events = historyStepEvents(history, messages);
  const boundary = events.find((event) => event.type === 'history_user_message');
  assert.deepEqual(boundary, { type: 'history_user_message', step: 2, messageId: 11 });
  assert.equal(events.some((event) => event.type === 'user_answer'), false);

  const uiMessages = runsToUiMessages([{ ...history, events, completedThrough: 2 }], history.id, [], messages);
  assert.deepEqual(uiMessages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(uiMessages[2].parts.find((part) => part.type === 'text')?.text, '请只处理其中一项');
});

test('step创建后接纳的追加输入显示在该step的唯一最终回复之前', () => {
  const history = run([step(1, { reasoning: null, output: '最终结果', toolCalls: [] })]);
  const messages = [
    userMessage(1, '开始任务', '2026-09-30T00:00:00.000Z'),
    userMessage(2, '新增要求', '2026-09-30T00:00:01.500Z'),
  ];
  const events = historyStepEvents(history, messages);
  assert.equal(events[0].type, 'history_user_message');
  const uiMessages = runsToUiMessages([{ ...history, events, completedThrough: 1 }], history.id, [], messages);
  assert.deepEqual(uiMessages.map((message) => message.role), ['user', 'user', 'assistant']);
  assert.equal(uiMessages[1].parts.find((part) => part.type === 'text')?.text, '新增要求');
  assert.equal(uiMessages[2].parts.filter((part) => part.type === 'text' && part.text === '最终结果').length, 1);
});

test('没有聚合响应的step不生成正文、推理或工具事件', () => {
  const incomplete: HistoryStep = {
    id: 'step-incomplete',
    idx: 1,
    assistantMessageId: null,
    result: null,
    toolResults: [],
    createdAt: '2026-09-30T00:00:01.000Z',
    completedAt: null,
  };
  assert.deepEqual(historyStepToEvents(incomplete), []);
  assert.deepEqual(historyStepEvents(run([incomplete], { status: 'running', output: null }), []), []);
});
