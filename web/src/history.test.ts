import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunWithEvents, ThreadContextMessage } from '@runforge/contracts';
import { appendPersistedRunUserMessage, runsToUiMessages } from './history';

function userMessage(id: number, runId: string, content: string): ThreadContextMessage {
  return {
    id,
    run_id: runId,
    step_id: null,
    role: 'user',
    tool_calls: [],
    tool_call_id: null,
    collapsed: null,
    summary_of: [],
    content_chars: content.length,
    content,
    created_at: `2026-09-20T00:00:0${id}.000Z`,
  };
}

test('runsToUiMessages 按 external input 事件把持久化用户消息插回对话顺序', () => {
  const run: RunWithEvents = {
    id: 'ru_test',
    thread_id: 'th_test',
    parent_run_id: null,
    status: 'done',
    input: '初始输入',
    output: '第二段回答',
    error: null,
    created_at: '2026-09-20T00:00:01.000Z',
    updated_at: '2026-09-20T00:00:05.000Z',
    events: [
      { type: 'step_start', step: 1 },
      { type: 'llm_delta', step: 1, text: '第一段回答' },
      { type: 'external_input_applied', step: 2, inputId: 'ri_test', version: 2 },
      { type: 'llm_delta', step: 2, text: '第二段回答' },
      { type: 'final', step: 2, output: '第二段回答' },
    ],
  };
  const messages = runsToUiMessages(
    [run],
    run.id,
    [],
    [userMessage(1, run.id, '初始输入'), userMessage(2, run.id, '系统追加的用户输入')],
  );

  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[0].parts.find((part) => part.type === 'text')?.text, '初始输入');
  assert.equal(messages[2].parts.find((part) => part.type === 'text')?.text, '系统追加的用户输入');
  assert.equal(messages[1].parts.find((part) => part.type === 'text')?.text, '第一段回答');
  assert.equal(messages[3].parts.find((part) => part.type === 'text')?.text, '第二段回答');
});

test('runsToUiMessages 在用户回答前保留 ask_user 的回答状态', () => {
  const run: RunWithEvents = {
    id: 'ru_answer',
    thread_id: 'th_test',
    parent_run_id: null,
    status: 'done',
    input: '开始',
    output: '继续完成',
    error: null,
    created_at: '2026-09-20T00:00:01.000Z',
    updated_at: '2026-09-20T00:00:05.000Z',
    events: [
      { type: 'user_question', step: 1, question: '是否继续？' },
      {
        type: 'user_answer',
        step: 2,
        answer: { mode: 'text', selected: [], customOptions: [], text: '继续', note: '', usedRecommended: false },
      },
      { type: 'llm_delta', step: 2, text: '继续完成' },
      { type: 'final', step: 2, output: '继续完成' },
    ],
  };
  const messages = runsToUiMessages(
    [run],
    run.id,
    [],
    [userMessage(1, run.id, '开始'), userMessage(2, run.id, '用户回答：\n继续')],
  );

  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[1].parts.some((part) => part.type === 'data-ask-user-question'), true);
  assert.equal(messages[1].parts.some((part) => part.type === 'data-ask-user-answer'), true);
});

test('appendPersistedRunUserMessage 在流式恢复时保留前段回答并创建新的助手消息位置', () => {
  const messages = appendPersistedRunUserMessage([
    { id: 'ru_answer:u', role: 'user', parts: [{ type: 'text', text: '开始' }] },
    {
      id: 'ru_answer:a',
      role: 'assistant',
      parts: [
        { type: 'data-run-id', id: 'ru_answer', data: { runId: 'ru_answer' } } as never,
        { type: 'data-ask-user-question', id: 'ask-1', data: { question: '是否继续？' } } as never,
      ],
    },
  ], 'ru_answer', {
    id: 2,
    content: '用户回答：\n继续',
    createdAt: '2026-09-20T00:00:02.000Z',
  }, {
    mode: 'text',
    selected: [],
    customOptions: [],
    text: '继续',
    note: '',
    usedRecommended: false,
  });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[1]?.id, 'ru_answer:a:0');
  assert.equal(messages[1]?.parts.some((part) => part.type === 'data-ask-user-answer'), true);
  assert.equal(messages[2]?.parts.find((part) => part.type === 'text')?.text, '用户回答：\n继续');
  assert.equal(messages[3]?.id, 'ru_answer:a');
  assert.equal(appendPersistedRunUserMessage(messages, 'ru_answer', {
    id: 2,
    content: '用户回答：\n继续',
    createdAt: '2026-09-20T00:00:02.000Z',
  }), messages);
});
