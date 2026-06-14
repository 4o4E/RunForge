import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from './executor.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { Provider } from '../llm/types.js';
import type { AgentEvent } from './types.js';
import { config } from '../config.js';
import { maskPlaceholder } from './compaction.js';
import type { ToolSettings } from '../settings.js';

let testWorkspace = '';

before(async () => {
  testWorkspace = await mkdtemp(join(tmpdir(), 'my-agent-executor-'));
});

after(async () => {
  await rm(testWorkspace, { recursive: true, force: true });
});

function testToolSettings(overrides: Partial<ToolSettings> = {}): ToolSettings {
  return {
    sandbox: 'enforce',
    sandboxBackend: 'bwrap',
    workspaceRoot: testWorkspace,
    allow: [],
    deny: [],
    shellEnabled: true,
    shellUseHostPath: true,
    shellAllowCommands: ['git', 'ls', 'sed', 'python', 'node'],
    network: 'enabled',
    shellDeny: [],
    maxOutput: 40000,
    ...overrides,
  };
}

function finishCall(id: string, progress: string, completed = true) {
  return {
    id,
    name: 'finish_conversation',
    arguments: JSON.stringify({ progress, completed }),
  };
}

// A provider that calls the `glob` tool on its first turn, then ends explicitly.
function scriptedProvider(): Provider {
  let turn = 0;
  return {
    name: 'scripted',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return { content: null, toolCalls: [{ id: 'call_1', name: 'glob', arguments: '{"pattern":"**/*.json"}' }] };
      }
      return { content: 'all done', toolCalls: [finishCall('finish_1', 'all done')] };
    },
  };
}

test('executeRun: runs the loop across steps and finalizes', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'find json files');

  const published: AgentEvent[] = [];
  await executeRun(run.id, {
    store,
    provider: scriptedProvider(),
    publish: (_id, e) => published.push(e),
    hardStepCap: 5,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'all done');

  // Two steps: step 1 (tool call), step 2 (explicit finish tool).
  const types = published.filter((e) => e.type !== 'stream_stats').map((e) => `${e.step}:${e.type}`);
  assert.deepEqual(types, [
    '1:step_start',
    '1:tool_call',
    '1:tool_result',
    '2:step_start',
    '2:llm_delta',
    '2:tool_call',
    '2:tool_result',
    '2:final',
  ]);
  const stats = published.filter((e): e is Extract<AgentEvent, { type: 'stream_stats' }> => e.type === 'stream_stats');
  assert.ok(stats.some((e) => e.totals.outputChars >= 'all done'.length));
  assert.ok(stats.some((e) => e.totals.toolInputChars > 0));
  assert.ok(stats.some((e) => e.totals.toolOutputChars > 0));

  // 对话会持久化为：用户消息、glob 的 assistant/tool 消息、finish 的 assistant/tool 消息。
  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool']);
});

test('executeRun: injects the current workspace root into the LLM context', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'clone a repo');
  let systemText = '';

  await executeRun(run.id, {
    store,
    provider: {
      name: 'capture-context',
      async complete(messages) {
        systemText = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
        return { content: null, toolCalls: [finishCall('finish_1', 'done')] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.match(systemText, /持久工作区根目录/);
  assert.match(systemText, new RegExp(testWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(systemText, /\/home\/user/);
  assert.match(systemText, /\/tmp/);
  assert.match(systemText, /当前可用目录/);
});

test('executeRun: activates a skill and trims tools to allowed-tools', async () => {
  const skillRoot = join(testWorkspace, '.skills', 'sample-skill');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    [
      '---',
      'name: sample-skill',
      'description: Use when a test needs a tiny skill.',
      'allowed-tools: file_read',
      '---',
      '',
      '# Sample Skill',
      '',
      'Read `references/details.md` only when needed.',
    ].join('\n'),
    'utf8',
  );

  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'use a skill');
  const published: AgentEvent[] = [];
  const toolNamesByTurn: string[][] = [];
  let firstSystemText = '';
  let secondSystemText = '';
  let turn = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'skill-aware',
      async complete(messages, tools) {
        turn += 1;
        toolNamesByTurn.push(tools.map((tool) => tool.name).sort());
        const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
        if (turn === 1) {
          firstSystemText = systemText;
          return {
            content: null,
            toolCalls: [
              { id: 'skill_1', name: 'skill_activate', arguments: '{"name":"sample-skill"}' },
              { id: 'read_1', name: 'file_read', arguments: JSON.stringify({ path: join(skillRoot, 'SKILL.md') }) },
            ],
          };
        }
        secondSystemText = systemText;
        return { content: 'done', toolCalls: [finishCall('finish_1', 'done')] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.match(firstSystemText, /sample-skill: Use when a test needs a tiny skill/);
  assert.match(secondSystemText, /已激活 Skill/);
  assert.match(secondSystemText, /root:/);
  assert.match(secondSystemText, /# Sample Skill/);
  assert.ok(toolNamesByTurn[0].includes('shell'));
  assert.ok(toolNamesByTurn[0].includes('skill_activate'));
  assert.ok(toolNamesByTurn[1].includes('file_read'));
  assert.ok(toolNamesByTurn[1].includes('finish_conversation'));
  assert.ok(toolNamesByTurn[1].includes('skill_activate'));
  assert.equal(toolNamesByTurn[1].includes('shell'), false);
  const activated = published.find((e) => e.type === 'skill_activated');
  assert.equal(activated?.type, 'skill_activated');
  assert.equal(activated?.type === 'skill_activated' ? activated.name : '', 'sample-skill');
  assert.deepEqual(activated?.type === 'skill_activated' ? activated.allowedTools : [], ['file_read']);
  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'tool']);
  assert.equal(msgs[2].toolCallId, 'skill_1');
  assert.equal(msgs[3].toolCallId, 'read_1');
  assert.equal(msgs.some((m) => m.role === 'system' && (m.content ?? '').includes('已激活 Skill')), false);
  assert.equal((await store.getRun(run.id))?.status, 'done');
});

test('executeRun: skill activation instructions do not leak into the next run history', async () => {
  const skillRoot = join(testWorkspace, '.skills', 'leaky-skill');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    ['---', 'name: leaky-skill', 'description: Use in leakage tests.', 'allowed-tools: file_read', '---', '', '# Leaky Skill'].join('\n'),
    'utf8',
  );

  const store = new MemoryStore();
  const thread = await store.createThread();
  const run1 = await store.createRun(thread.id, 'activate skill');
  let turn = 0;
  await executeRun(run1.id, {
    store,
    provider: {
      name: 'activate-then-finish',
      async complete() {
        turn += 1;
        if (turn === 1) return { content: null, toolCalls: [{ id: 'skill_1', name: 'skill_activate', arguments: '{"name":"leaky-skill"}' }] };
        return { content: null, toolCalls: [finishCall('finish_1', 'done')] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  const run2 = await store.createRun(thread.id, 'new run');
  let secondRunSystemText = '';
  await executeRun(run2.id, {
    store,
    provider: {
      name: 'capture-next-run',
      async complete(messages) {
        secondRunSystemText = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
        return { content: null, toolCalls: [finishCall('finish_2', 'done')] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.equal(secondRunSystemText.includes('已激活 Skill'), false);
  assert.equal(secondRunSystemText.includes('# Leaky Skill'), false);
});

test('executeRun: streams tool input stats without double counting final tool args', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'finish via streamed tool args');
  const args = JSON.stringify({ progress: 'done', completed: true });
  const published: AgentEvent[] = [];

  await executeRun(run.id, {
    store,
    provider: {
      name: 'stream-tool-input',
      async complete() {
        throw new Error('complete should not be used');
      },
      async completeStream(_messages, _tools, onDelta) {
        onDelta({ toolInputStart: { id: 'finish_1', name: 'finish_conversation' } });
        onDelta({ toolInputDelta: { id: 'finish_1', name: 'finish_conversation', delta: args.slice(0, 12) } });
        onDelta({ toolInputDelta: { id: 'finish_1', name: 'finish_conversation', delta: args.slice(12) } });
        return { content: null, toolCalls: [finishCall('finish_1', 'done')] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  const stats = published.filter((e): e is Extract<AgentEvent, { type: 'stream_stats' }> => e.type === 'stream_stats');
  const maxToolInputChars = Math.max(...stats.map((e) => e.totals.toolInputChars));
  assert.equal(maxToolInputChars, Array.from(args).length);
});

test('executeRun: keeps multi-turn memory within a thread', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();

  const run1 = await store.createRun(thread.id, 'first');
  await executeRun(run1.id, {
    store,
    provider: { name: 's', async complete() { return { content: 'ok1', toolCalls: [finishCall('f1', 'ok1')] }; } },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  // Second run should see the first run's messages as prior context.
  let seenPriorCount = 0;
  const run2 = await store.createRun(thread.id, 'second');
  await executeRun(run2.id, {
    store,
    provider: {
      name: 's',
      async complete(messages) {
        seenPriorCount = messages.filter((m) => m.role !== 'system').length;
        return { content: 'ok2', toolCalls: [finishCall('f2', 'ok2')] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  // prior: user(first) + assistant(finish call) + tool(finish result) + new user(second) = 4
  assert.equal(seenPriorCount, 4);
});

test('executeRun: compacts bulky old history when finishing a run', async () => {
  const { keepRecentMessages } = config.agent;
  config.agent.keepRecentMessages = 2;
  try {
    const store = new MemoryStore();
    const thread = await store.createThread();
    const oldRun = await store.createRun(thread.id, 'old');
    const bigArgs = JSON.stringify({ path: 'artifacts/old.html', html: 'r'.repeat(3000) });
    await store.addMessage(thread.id, oldRun.id, null, {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'html-old', name: 'write_html_artifact', arguments: bigArgs }],
    });
    await store.addMessage(thread.id, oldRun.id, null, { role: 'tool', content: 'x'.repeat(4000), toolCallId: 'html-old' });

    const run = await store.createRun(thread.id, 'new');
    const published: AgentEvent[] = [];
    await executeRun(run.id, {
      store,
      provider: { name: 's', async complete() { return { content: 'ok', toolCalls: [finishCall('f1', 'ok')] }; } },
      publish: (_id, e) => published.push(e),
      hardStepCap: 3,
      toolSettings: testToolSettings(),
    });

    const msgs = await store.loadThreadMessages(thread.id);
    const oldAssistant = msgs.find((m) => m.toolCalls?.[0]?.id === 'html-old');
    const oldTool = msgs.find((m) => m.toolCallId === 'html-old');
    assert.equal(oldAssistant?.collapsed, 'masked');
    const placeholder = JSON.parse(oldAssistant?.toolCalls?.[0]?.arguments ?? '{}');
    assert.equal(placeholder.context_elided, true);
    assert.equal(placeholder.not_executable, true);
    assert.equal(placeholder.tool_name, 'write_html_artifact');
    assert.equal(oldTool?.content, maskPlaceholder('x'.repeat(4000)));
    assert.ok(published.some((e) => e.type === 'compaction' && e.reason === 'post-run-history'));
  } finally {
    config.agent.keepRecentMessages = keepRecentMessages;
  }
});

test('executeRun: text without finish_conversation is not completion', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'answer directly');

  await executeRun(run.id, {
    store,
    provider: {
      name: 'no-finish',
      async complete() {
        return { content: 'premature final answer', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 2,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'error');
  assert.match(finished?.error ?? '', /hard step cap/);
});

test('executeRun: stops and errors at the hard step cap', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'loop forever');

  await executeRun(run.id, {
    store,
    // Always asks for a tool, never finalizes.
    provider: {
      name: 'looper',
      async complete() {
        return { content: null, toolCalls: [{ id: 'c', name: 'glob', arguments: '{"pattern":"*"}' }] };
      },
    },
    publish: () => {},
    hardStepCap: 2,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'error');
  assert.match(finished?.error ?? '', /hard step cap/);
});

test('executeRun: cancels cooperatively at a step boundary', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'long task');

  // Flip the run to 'canceling' the moment the loop starts its first step, so the
  // top-of-step check observes it and stops before finalizing.
  let turn = 0;
  await executeRun(run.id, {
    store,
    provider: {
      name: 'looper',
      async complete() {
        turn += 1;
        if (turn === 1) await store.setRunStatus(run.id, 'canceling');
        return { content: null, toolCalls: [{ id: 'c', name: 'glob', arguments: '{"pattern":"*"}' }] };
      },
    },
    publish: () => {},
    hardStepCap: 50,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'canceled');
});

test('executeRun: ask_user pauses the run and keeps tool pairing intact', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'needs clarification');
  const published: AgentEvent[] = [];

  await executeRun(run.id, {
    store,
    provider: {
      name: 'asker',
      async complete() {
        return {
          content: null,
          toolCalls: [
            {
              id: 'ask_1',
              name: 'ask_user',
              arguments:
                '{"question":"继续吗？","mode":"single","allowCustom":true,"required":true,"options":[{"id":"yes","label":"继续","recommended":true,"required":true},{"id":"no","label":"暂停"}]}',
            },
          ],
        };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  const paused = await store.getRun(run.id);
  assert.equal(paused?.status, 'waiting_for_user');
  assert.ok(published.some((e) => e.type === 'user_question' && e.question === '继续吗？'));
  const question = published.find((e) => e.type === 'user_question');
  assert.equal(question?.type === 'user_question' ? question.spec?.mode : undefined, 'single');
  assert.equal(question?.type === 'user_question' ? question.spec?.allowCustom : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.required : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.options[0]?.recommended : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.options[0]?.required : undefined, true);

  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[2].toolCallId, 'ask_1');
});

test('executeRun: rejects malformed string-wrapped tool args without running the tool', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'write a file');
  const published: AgentEvent[] = [];
  let turn = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'bad-tool-args',
      async complete() {
        turn += 1;
        if (turn === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'write_1',
                name: 'file_write',
                arguments: JSON.stringify('{"path":"/tmp/should-not-exist","content":"broken"'),
              },
            ],
          };
        }
        return { content: 'done', toolCalls: [finishCall('finish_1', 'recovered')] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  const failedTool = published.find((e) => e.type === 'tool_result' && e.id === 'write_1');
  assert.equal(failedTool?.type, 'tool_result');
  assert.match(failedTool?.type === 'tool_result' ? failedTool.result : '', /工具参数无效，未执行 file_write/);
  assert.equal((await store.getRun(run.id))?.output, 'recovered');
});

test('executeRun: resumes the same run after a user answer without duplicating input', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'needs answer');
  let turn = 0;
  const provider: Provider = {
    name: 'resume',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{ id: 'ask_1', name: 'ask_user', arguments: '{"question":"选 A 还是 B？"}' }],
        };
      }
      return { content: 'ok', toolCalls: [finishCall('finish_1', 'used answer')] };
    },
  };

  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, toolSettings: testToolSettings() });
  await store.addMessage(thread.id, run.id, null, { role: 'user', content: '用户回答：\nA' });
  await store.setRunStatus(run.id, 'pending');
  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, resume: true, toolSettings: testToolSettings() });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'used answer');
  const msgs = await store.loadThreadMessages(thread.id);
  assert.equal(msgs.filter((m) => m.role === 'user' && m.content === 'needs answer').length, 1);
  assert.ok(msgs.some((m) => m.role === 'user' && m.content?.includes('用户回答')));
});

test('memory store: deleteThread removes dependent run data', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'delete me');
  await store.addMessage(thread.id, run.id, null, { role: 'user', content: 'delete me' });
  await store.addEvent(run.id, null, { type: 'final', step: 1, output: 'done' });

  assert.equal(await store.deleteThread(thread.id), true);
  assert.equal(await store.getThread(thread.id), null);
  assert.deepEqual(await store.listRuns(thread.id), []);
  assert.deepEqual(await store.loadThreadMessages(thread.id), []);
  assert.deepEqual(await store.getEvents(run.id), []);
});
