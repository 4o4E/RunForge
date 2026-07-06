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
import { maybeGenerateThreadTitleAfterFirstRun } from './threadTitle.js';

let testWorkspace = '';

before(async () => {
  testWorkspace = await mkdtemp(join(tmpdir(), 'runforge-executor-'));
});

after(async () => {
  await rm(testWorkspace, { recursive: true, force: true });
});

function testToolSettings(overrides: Partial<ToolSettings> = {}): ToolSettings {
  return {
    sandbox: 'enforce',
    sandboxBackend: 'bwrap',
    workspaceRoot: testWorkspace,
    toolAccessMode: 'deny',
    allow: [],
    deny: [],
    shellEnabled: true,
    shellUseHostPath: true,
    shellPathMode: 'system',
    shellPath: process.env.PATH ?? '',
    shellAllowCommands: ['git', 'ls', 'sed', 'python', 'node'],
    network: 'enabled',
    shellDeny: [],
    maxOutput: 40000,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('等待条件超时');
}

// 一个先调用工具、再直接输出最终汇报的 provider。
function scriptedProvider(): Provider {
  let turn = 0;
  return {
    name: 'scripted',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return { content: null, toolCalls: [{ id: 'call_1', name: 'glob', arguments: '{"pattern":"**/*.json"}' }] };
      }
      return { content: 'all done', toolCalls: [] };
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

  // 两步：第一步调用工具，第二步直接输出最终汇报。
  const types = published
    .filter((e) => e.type !== 'stream_stats' && e.type !== 'usage_update')
    .map((e) => `${e.step}:${e.type}`);
  assert.deepEqual(types, [
    '1:step_start',
    '1:tool_call',
    '1:tool_result',
    '2:step_start',
    '2:final',
  ]);
  const usage = published.filter((e): e is Extract<AgentEvent, { type: 'usage_update' }> => e.type === 'usage_update');
  assert.deepEqual(usage.map((e) => e.step), [1, 2]);
  assert.ok(usage.every((e) => e.estContextTokens !== undefined && e.contextBudget === config.agent.contextBudget));
  const stats = published.filter((e): e is Extract<AgentEvent, { type: 'stream_stats' }> => e.type === 'stream_stats');
  assert.ok(stats.some((e) => e.totals.outputChars >= 'all done'.length));
  assert.ok(stats.some((e) => e.totals.toolInputChars > 0));
  assert.ok(stats.some((e) => e.totals.toolOutputChars > 0));

  // 对话会持久化为：用户消息、glob 的 assistant/tool 消息、最终 assistant 消息。
  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
});

test('thread title: uses first input as fallback and generates for an empty-title branch', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, '修复登录页提交后没有响应的问题');
  assert.equal((await store.listThreads())[0]?.fallback_title, '修复登录页提交后没有响应的问题');
  await store.setRunStatus(run.id, 'done', { output: '已经从表单提交链路修复根因。' });

  const updated = await maybeGenerateThreadTitleAfterFirstRun(run.id, {
    store,
    provider: {
      name: 'title-provider',
      async complete() {
        return { content: '登录提交无响应修复', toolCalls: [] };
      },
    },
  });

  assert.equal(updated?.title, '登录提交无响应修复');

  const titledRun = await store.createRun(thread.id, '继续优化样式');
  await store.setRunStatus(titledRun.id, 'done', { output: 'done' });
  const skipped = await maybeGenerateThreadTitleAfterFirstRun(titledRun.id, {
    store,
    provider: {
      name: 'unused-title-provider',
      async complete() {
        throw new Error('第二轮不应该生成标题');
      },
    },
  });
  assert.equal(skipped, null);
  assert.equal((await store.getThread(thread.id))?.title, '登录提交无响应修复');

  const untitledThread = await store.createThread();
  const firstRun = await store.createRun(untitledThread.id, '杭州到余姚这一块，夏天玩水或者漂流都有哪些地方可以玩');
  await store.setRunStatus(firstRun.id, 'done', { output: '沿线有多个玩水点。' });
  const secondRun = await store.createRun(untitledThread.id, '我的意思是这一块找一个地方玩，而不是一路玩过去');
  assert.equal((await store.getThread(untitledThread.id))?.fallback_title, '杭州到余姚这一块，夏天玩水或者漂流都有哪些地方可以玩');
  await store.setRunStatus(secondRun.id, 'done', { output: '更适合选余姚四明山一带。' });
  const backfilled = await maybeGenerateThreadTitleAfterFirstRun(secondRun.id, {
    store,
    provider: {
      name: 'branch-title-provider',
      async complete(messages) {
        assert.match(messages[1]?.content ?? '', /我的意思是这一块找一个地方玩/);
        return { content: '余姚玩水地点选择', toolCalls: [] };
      },
    },
  });
  assert.equal(backfilled?.title, '余姚玩水地点选择');
});

test('thread title: keeps generated title and fallback concise for the sidebar', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, '请帮我分析跨平台对话模型优化方案，以及后续落地建议');
  await store.setRunStatus(run.id, 'done', { output: '建议从上下文、路由和评估三个方向优化。' });

  const updated = await maybeGenerateThreadTitleAfterFirstRun(run.id, {
    store,
    provider: {
      name: 'verbose-title-provider',
      async complete() {
        return { content: '请帮我分析跨平台对话模型优化方案，以及后续落地建议', toolCalls: [] };
      },
    },
  });

  assert.equal(updated?.title, '跨平台对话模型优化方案');

  const fallbackThread = await store.createThread();
  const fallbackRun = await store.createRun(fallbackThread.id, '楼下50米洗车，建议直接开车还是走路');
  await store.setRunStatus(fallbackRun.id, 'done', { output: '建议直接走路。' });

  const fallback = await maybeGenerateThreadTitleAfterFirstRun(fallbackRun.id, {
    store,
    provider: {
      name: 'empty-title-provider',
      async complete() {
        return { content: '', toolCalls: [] };
      },
    },
  });

  assert.equal(fallback?.title, '楼下50米洗车');
});

test('thread title: extracts concise title from json-like provider output', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, '整理Ubuntu 24安装NVIDIA驱动的步骤');
  await store.setRunStatus(run.id, 'done', { output: '按驱动版本和安全启动状态拆分步骤。' });

  const updated = await maybeGenerateThreadTitleAfterFirstRun(run.id, {
    store,
    provider: {
      name: 'json-title-provider',
      async complete() {
        return { content: '```json\n{"title":"Ubuntu 24 安装驱动"}\n```', toolCalls: [] };
      },
    },
  });

  assert.equal(updated?.title, 'Ubuntu 24 安装驱动');
});

test('executeRun: generates a thread title after completion when enabled', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, '规划一次杭州周边漂流');
  let calls = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'final-and-title',
      async complete(messages) {
        calls += 1;
        const titlePrompt = messages.some((message) => message.content?.includes('thread 标题生成器'));
        return titlePrompt
          ? { content: '杭州周边漂流规划', toolCalls: [] }
          : { content: '推荐去安吉漂流。', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
    generateThreadTitle: true,
  });

  await waitUntil(async () => (await store.getThread(thread.id))?.title === '杭州周边漂流规划');
  assert.equal((await store.getThread(thread.id))?.title, '杭州周边漂流规划');
  assert.equal(calls, 2);
});

test('executeRun: persists streamed text and terminal stream status for replay', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'stream a final answer');
  const published: AgentEvent[] = [];

  await executeRun(run.id, {
    store,
    provider: {
      name: 'streaming-final',
      async complete() {
        assert.fail('流式 provider 不应回退到非流式 complete');
      },
      async completeStream(_messages, _tools, onDelta) {
        onDelta({ reasoning: '想' });
        onDelta({ content: 'he' });
        onDelta({ content: 'llo' });
        return { content: 'hello', reasoning: '想', toolCalls: [] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    stream: true,
    toolSettings: testToolSettings(),
  });

  const events = await store.getEvents(run.id);
  const textEvents = events.filter((e): e is Extract<AgentEvent, { type: 'llm_delta' }> => e.type === 'llm_delta');
  assert.deepEqual(textEvents.map((e) => e.text), ['he', 'llo']);
  assert.equal(textEvents.map((e) => e.text).join(''), 'hello');
  assert.equal(events.filter((e) => e.type === 'reasoning').length, 1);
  assert.ok(events.some((e) => e.type === 'reasoning_timing'));
  assert.ok(events.some((e) => e.type === 'stream_stats' && e.stage === 'done' && e.totals.outputChars === 5));
  assert.equal(events.at(-1)?.type, 'final');
  assert.ok(published.some((e) => e.type === 'llm_delta' && e.text === 'he'));
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
        return { content: 'done', toolCalls: [] };
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

test('executeRun: injects database workload token at run startup', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'check datasource env');
  let sawRuntimeContext = false;
  let sawSkillReusedRunEnv = false;
  let turn = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'database-runtime-env',
      async complete(messages) {
        turn += 1;
        if (turn === 1) {
          sawRuntimeContext = messages.some((message) => (
            message.role === 'system'
            && (message.content ?? '').includes('数据库访问运行环境（run 级）')
            && (message.content ?? '').includes('DB_WORKLOAD_TOKEN=已注入')
          ));
          return {
            content: null,
            toolCalls: [{
              id: 'skill_1',
              name: 'skill_activate',
              arguments: '{"name":"database-access"}',
            }],
          };
        }
        sawSkillReusedRunEnv = messages.some((message) => (
          message.role === 'system'
          && (message.content ?? '').includes('数据库访问运行环境已在 run 初始化时注入')
        ));
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
    databaseRuntimeEnv: async () => ({
      env: {
        DB_WORKLOAD_TOKEN: 'wat_test_runtime',
        RUNFORGE_RUNTIME_API_BASE: 'http://localhost:8080/api/runtime',
        DATASOURCE_ID: 'ds_test',
        DATASOURCE_PROFILE: 'readonly',
      },
      summary: [
        '数据库访问运行环境（run 级）:',
        '- DB_WORKLOAD_TOKEN=已注入',
        '- DATASOURCE_ID=ds_test',
      ].join('\n'),
    }),
  });

  assert.equal(sawRuntimeContext, true);
  assert.equal(sawSkillReusedRunEnv, true);
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
        return { content: 'done', toolCalls: [] };
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
  assert.ok(toolNamesByTurn[1].includes('skill_activate'));
  assert.equal(toolNamesByTurn[1].includes('shell'), false);
  const activated = published.find((e) => e.type === 'skill_activated');
  assert.equal(activated?.type, 'skill_activated');
  assert.equal(activated?.type === 'skill_activated' ? activated.name : '', 'sample-skill');
  assert.deepEqual(activated?.type === 'skill_activated' ? activated.allowedTools : [], ['file_read']);
  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
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
        return { content: 'done', toolCalls: [] };
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
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.equal(secondRunSystemText.includes('已激活 Skill'), false);
  assert.equal(secondRunSystemText.includes('# Leaky Skill'), false);
});

test('executeRun: starts async subagents and allows cross-run polling', async () => {
  const skillRoot = join(testWorkspace, '.skills', 'review-skill');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    ['---', 'name: review-skill', 'description: Review a focused change.', '---', '', '# Review Skill', '', 'Only report concrete risks.'].join('\n'),
    'utf8',
  );

  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'delegate review');
  const published: AgentEvent[] = [];
  const subagentPrompts: string[] = [];
  let parentTurn = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'subagent-aware',
      async complete(messages) {
        const prompt = messages.map((m) => m.content ?? '').join('\n');
        if (prompt.includes('异步只读推理型 subagent')) {
          subagentPrompts.push(prompt);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { content: '没有发现阻塞风险。', toolCalls: [] };
        }
        parentTurn += 1;
        if (parentTurn === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'sub_1',
                name: 'subagent_run',
                arguments: JSON.stringify({
                  stageId: 'review',
                  stageGoal: '确认变更是否有阻塞问题。',
                  runtimeProfileId: 'readonly',
                  skillNames: ['review-skill'],
                  task: '审查 executor 的 subagent 分支。',
                  expectedOutput: '只输出风险和证据。',
                }),
              },
              {
                id: 'sub_2',
                name: 'subagent_run',
                arguments: JSON.stringify({
                  stageId: 'test',
                  stageGoal: '确认测试覆盖是否足够。',
                  runtimeProfileId: 'readonly',
                  task: '检查是否需要补充 subagent 异步测试。',
                  expectedOutput: '列出测试建议。',
                }),
              },
            ],
          };
        }
        return { content: '已启动两个 subagent。', toolCalls: [] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 4,
    toolSettings: testToolSettings(),
  });

  const started = published.find((e) => e.type === 'subagent_started');
  assert.equal(started?.type, 'subagent_started');
  assert.equal(started?.type === 'subagent_started' ? started.stageId : '', 'review');
  assert.deepEqual(started?.type === 'subagent_started' ? started.skillNames : [], ['review-skill']);
  assert.equal((await store.getRun(run.id))?.status, 'done');

  let msgs = await store.loadThreadMessages(thread.id);
  const subagentStartResult = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'sub_1')?.content ?? '';
  assert.match(subagentStartResult, /subagentRunId: sr_/);
  assert.match(subagentStartResult, /status: running/);
  assert.doesNotMatch(subagentStartResult, /没有发现阻塞风险/);

  await waitUntil(() => published.filter((e) => e.type === 'subagent_finished').length === 2);
  assert.match(subagentPrompts.join('\n'), /# Review Skill/);
  const rows = await store.listSubagentRunsByThread(thread.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.status === 'done'), true);
  assert.match(rows[0].output ?? '', /没有发现阻塞风险/);

  const run2 = await store.createRun(thread.id, 'poll previous subagent');
  let pollTurn = 0;
  await executeRun(run2.id, {
    store,
    provider: {
      name: 'subagent-poller',
      async complete(messages) {
        pollTurn += 1;
        if (pollTurn === 1) {
          const history = messages.map((m) => m.content ?? '').join('\n');
          const subagentRunId = history.match(/subagentRunId: (sr_[A-Za-z0-9]+)/)?.[1] ?? rows[0].id;
          return {
            content: null,
            toolCalls: [{ id: 'poll_1', name: 'subagent_poll', arguments: JSON.stringify({ subagentRunId }) }],
          };
        }
        return { content: '已读取上一个 run 的 subagent 结果。', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 4,
    toolSettings: testToolSettings(),
  });

  assert.equal((await store.getRun(run2.id))?.status, 'done');
  msgs = await store.loadThreadMessages(thread.id);
  const pollResult = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'poll_1')?.content ?? '';
  assert.match(pollResult, /status: done/);
  assert.match(pollResult, /没有发现阻塞风险/);
});

test('executeRun: repeated running subagent polls do not trigger loop guard', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'wait for slow subagent');
  const published: AgentEvent[] = [];
  let parentTurn = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'slow-subagent',
      async complete(messages) {
        const prompt = messages.map((m) => m.content ?? '').join('\n');
        if (prompt.includes('异步只读推理型 subagent')) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { content: '慢速 subagent 已完成。', toolCalls: [] };
        }
        parentTurn += 1;
        if (parentTurn === 1) {
          return {
            content: null,
            toolCalls: [{ id: 'sub_1', name: 'subagent_run', arguments: JSON.stringify({ task: '慢速检查。' }) }],
          };
        }
        const history = messages.map((m) => m.content ?? '').join('\n');
        const subagentRunId = history.match(/subagentRunId: (sr_[A-Za-z0-9]+)/)?.[1];
        if (subagentRunId && !history.includes('慢速 subagent 已完成。')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            content: null,
            toolCalls: [{ id: `poll_${parentTurn}`, name: 'subagent_poll', arguments: JSON.stringify({ subagentRunId }) }],
          };
        }
        return { content: '已汇总慢速 subagent 结果。', toolCalls: [] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 10,
    toolSettings: testToolSettings(),
  });

  assert.equal((await store.getRun(run.id))?.status, 'done');
  assert.equal(published.some((event) => event.type === 'progress_stalled'), false);
  const pollResults = (await store.loadThreadMessages(thread.id)).filter((msg) => msg.role === 'tool' && msg.toolCallId?.startsWith('poll_'));
  assert.equal(pollResults.some((msg) => /\bstatus: running\b/.test(msg.content ?? '')), true);
  assert.equal(pollResults.some((msg) => /\bstatus: done\b/.test(msg.content ?? '')), true);
});

test('executeRun: streams tool input stats without double counting final tool args', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'update plan via streamed tool args');
  const args = JSON.stringify({ phase: 'reporting', next: '汇报结果' });
  const published: AgentEvent[] = [];
  let turn = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'stream-tool-input',
      async complete() {
        return { content: 'done', toolCalls: [] };
      },
      async completeStream(_messages, _tools, onDelta) {
        turn += 1;
        if (turn > 1) return { content: 'done', toolCalls: [] };
        onDelta({ toolInputStart: { id: 'plan_1', name: 'update_plan' } });
        onDelta({ toolInputDelta: { id: 'plan_1', name: 'update_plan', delta: args.slice(0, 12) } });
        onDelta({ toolInputDelta: { id: 'plan_1', name: 'update_plan', delta: args.slice(12) } });
        return { content: null, toolCalls: [{ id: 'plan_1', name: 'update_plan', arguments: args }] };
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

test('executeRun: update_plan turn does not finalize until a no-tool final answer', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'write a final report and close the plan');
  const sameTurnText = '计划已收口，下一轮输出最终报告。';
  const finalText = '完整分析报告\n\n结论：所有步骤已经完成。';
  const published: AgentEvent[] = [];
  let turns = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'answer-then-plan',
      async complete() {
        turns += 1;
        if (turns > 1) return { content: finalText, toolCalls: [] };
        return {
          content: sameTurnText,
          toolCalls: [
            {
              id: 'plan_done',
              name: 'update_plan',
              arguments: JSON.stringify({
                phase: 'completed',
                plan: [{ text: '完成分析报告', status: 'done' }],
                next: '已完成',
              }),
            },
          ],
        };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(turns, 2);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, finalText);
  assert.equal(finished?.goal_state?.phase, 'completed');
  assert.equal(published.some((event) => event.type === 'final' && event.output === finalText), true);
  assert.equal(published.some((event) => event.type === 'final' && event.output === sameTurnText), false);

  const msgs = await store.loadThreadMessages(thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[1]?.content, sameTurnText);
  assert.equal(msgs[2]?.toolCallId, 'plan_done');
  assert.equal(msgs[3]?.content, finalText);
});

test('executeRun: auto-completes the final report plan item without a second summary turn', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'produce a report');
  const finalText = '## 完整报告\n\n这里是完整可见的最终内容。';
  const published: AgentEvent[] = [];
  let turns = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'auto-report-step',
      async complete() {
        turns += 1;
        if (turns === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'plan_1',
                name: 'update_plan',
                arguments: JSON.stringify({
                  phase: 'reporting',
                  plan: [
                    { text: '完成分析', status: 'done' },
                    { text: '汇总结果并汇报', status: 'doing', autoComplete: true },
                  ],
                  next: '输出最终报告',
                }),
              },
            ],
          };
        }
        return { content: finalText, toolCalls: [] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 4,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(turns, 2);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, finalText);
  assert.deepEqual(finished?.goal_state?.plan.map((item) => item.status), ['done', 'done']);
  assert.equal(published.some((event) => event.type === 'final' && event.output === finalText), true);
});

test('executeRun: final text closes the run even when plan is still open', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'produce then close plan');
  const finalText = '## 完整报告\n\n这是先输出、后被计划状态挡住的完整报告。';
  const published: AgentEvent[] = [];
  let turns = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'deferred-final',
      async complete() {
        turns += 1;
        if (turns === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'plan_1',
                name: 'update_plan',
                arguments: JSON.stringify({
                  phase: 'reporting',
                  plan: [
                    { text: '完成分析', status: 'done' },
                    { text: '收尾', status: 'doing' },
                  ],
                }),
              },
            ],
          };
        }
        if (turns === 2) return { content: finalText, toolCalls: [] };
        assert.fail('最终正文输出后不应该为了关闭计划继续调用模型');
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 5,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(turns, 2);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, finalText);
  assert.equal(finished?.goal_state?.phase, 'completed');
  assert.deepEqual(finished?.goal_state?.plan.map((item) => item.status), ['done', 'doing']);
  assert.equal(finished?.goal_state?.next, '已结束（存在未完成项）');
  assert.equal(published.some((event) => event.type === 'final' && event.output === finalText), true);
  assert.equal(published.filter((event) => event.type === 'final').length, 1);
});

test('executeRun: keeps multi-turn memory within a thread', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();

  const run1 = await store.createRun(thread.id, 'first');
  await executeRun(run1.id, {
    store,
    provider: { name: 's', async complete() { return { content: 'ok1', toolCalls: [] }; } },
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
        return { content: 'ok2', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  // prior: user(first) + assistant(final) + new user(second) = 3
  assert.equal(seenPriorCount, 3);
});

test('executeRun: compacts bulky old history when finishing a run', async () => {
  const { keepRecentMessages } = config.agent;
  config.agent.keepRecentMessages = 2;
  try {
    const store = new MemoryStore();
    const thread = await store.createThread();
    const oldRun = await store.createRun(thread.id, 'old');
    const bigArgs = JSON.stringify({ path: 'generated/old.txt', content: 'r'.repeat(3000) });
    await store.addMessage(thread.id, oldRun.id, null, {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'file-old', name: 'file_write', arguments: bigArgs }],
    });
    await store.addMessage(thread.id, oldRun.id, null, { role: 'tool', content: 'x'.repeat(4000), toolCallId: 'file-old' });

    const run = await store.createRun(thread.id, 'new');
    const published: AgentEvent[] = [];
    await executeRun(run.id, {
      store,
      provider: { name: 's', async complete() { return { content: 'ok', toolCalls: [] }; } },
      publish: (_id, e) => published.push(e),
      hardStepCap: 3,
      toolSettings: testToolSettings(),
    });

    const msgs = await store.loadThreadMessages(thread.id);
    const oldAssistant = msgs.find((m) => m.toolCalls?.[0]?.id === 'file-old');
    const oldTool = msgs.find((m) => m.toolCallId === 'file-old');
    assert.equal(oldAssistant?.collapsed, 'masked');
    const placeholder = JSON.parse(oldAssistant?.toolCalls?.[0]?.arguments ?? '{}');
    assert.equal(placeholder.context_elided, true);
    assert.equal(placeholder.not_executable, true);
    assert.equal(placeholder.tool_name, 'file_write');
    assert.equal(oldTool?.content, maskPlaceholder('x'.repeat(4000)));
    assert.ok(published.some((e) => e.type === 'compaction' && e.reason === 'post-run-history'));
  } finally {
    config.agent.keepRecentMessages = keepRecentMessages;
  }
});

test('executeRun: text without tools completes when no plan is open', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'answer directly');

  await executeRun(run.id, {
    store,
    provider: {
      name: 'direct-final',
      async complete() {
        return { content: 'premature final answer', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 2,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'premature final answer');
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
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  const failedTool = published.find((e) => e.type === 'tool_result' && e.id === 'write_1');
  assert.equal(failedTool?.type, 'tool_result');
  assert.match(failedTool?.type === 'tool_result' ? failedTool.result : '', /工具参数无效，未执行 file_write/);
  assert.equal((await store.getRun(run.id))?.output, 'done');
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
      return { content: 'ok', toolCalls: [] };
    },
  };

  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, toolSettings: testToolSettings() });
  await store.addMessage(thread.id, run.id, null, { role: 'user', content: '用户回答：\nA' });
  await store.setRunStatus(run.id, 'pending');
  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, resume: true, toolSettings: testToolSettings() });

  const finished = await store.getRun(run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'ok');
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
  const session = await store.createShellSession({ threadId: thread.id, name: 'Default', owner: 'system', workspaceRoot: '/tmp/ws', backend: 'none' });
  const command = await store.createShellCommand({
    sessionId: session.id,
    runId: run.id,
    actor: 'agent',
    command: 'printf ok',
    cwd: '/tmp/ws',
    waitMode: 'foreground',
  });
  await store.appendShellCommandLog(command.id, 'stdout', 'ok');

  assert.equal(await store.deleteThread(thread.id), true);
  assert.equal(await store.getThread(thread.id), null);
  assert.deepEqual(await store.listRuns(thread.id), []);
  assert.deepEqual(await store.loadThreadMessages(thread.id), []);
  assert.deepEqual(await store.getEvents(run.id), []);
  assert.deepEqual(await store.listShellSessions(thread.id), []);
  assert.deepEqual(await store.getShellCommand(command.id), null);
  assert.deepEqual(await store.getShellCommandLogs(command.id), []);
});
