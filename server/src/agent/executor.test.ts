import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import type { AppliedRunInput, Scope } from '../store/types.js';
import { ProviderRunner } from '../llm/providerRunner.js';
import { MemoryProviderObservationRepository } from '../llm/observability/repository.js';
import { BusinessPluginRegistry } from '../businessPlugins/registry.js';
import { BusinessPluginRuntimeService } from '../businessPlugins/runtime.js';
import { createBusinessPluginSelection } from '../businessPlugins/cordis.js';
import { createSpaceRuntimeLock } from '../plugins/lock.js';

const scope: Scope = { tenantId: 'default', userId: 'us_test' };

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

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

class NextStepMemoryStore extends MemoryStore {
  private readonly pending = new Map<string, Array<{ inputId: string; version: number; content: string }>>();
  private version = 0;

  async enqueue(scopeValue: Scope, runId: string, content: string): Promise<void> {
    const run = await this.getRun(scopeValue, runId);
    assert.equal(run?.external_input_open, true, 'run 应处于 next_step 接纳窗口');
    this.version += 1;
    const list = this.pending.get(runId) ?? [];
    list.push({ inputId: `ri_test_${this.version}`, version: this.version, content });
    this.pending.set(runId, list);
  }

  override async applyPendingRunInputs(scopeValue: Scope, runId: string): Promise<AppliedRunInput[]> {
    const run = await this.getRun(scopeValue, runId);
    if (!run) return [];
    const inputs = this.pending.get(runId) ?? [];
    this.pending.delete(runId);
    const applied: AppliedRunInput[] = [];
    for (const input of inputs) {
      const messageId = await this.addMessage(scopeValue, run.thread_id, runId, null, {
        role: 'user',
        content: input.content,
      });
      applied.push({ ...input, messageId });
    }
    return applied;
  }

  override async closeExternalInputAndApplyPending(scopeValue: Scope, runId: string) {
    const closed = await super.closeExternalInputAndApplyPending(scopeValue, runId);
    if (!closed.closed) return closed;
    const inputs = await this.applyPendingRunInputs(scopeValue, runId);
    if (inputs.length) {
      const run = await this.getRun(scopeValue, runId);
      if (run) run.external_input_open = true;
    }
    return { closed: true, inputs };
  }
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

function truncatedStreamProvider(state: { retryMessages: string[] }): Provider {
  let turn = 0;
  return {
    name: 'fake-truncated-stream',
    async complete() {
      throw new Error('流式 provider 不应回退到非流式 complete');
    },
    async completeStream(messages, _tools, onDelta) {
      turn += 1;
      if (turn === 1) {
        onDelta({ content: '第一段半截' });
        onDelta({ content: '，停在这里' });
        return {
          content: '第一段半截，停在这里',
          toolCalls: [],
          finishReason: 'length',
          rawFinishReason: 'max_output_tokens',
        };
      }
      state.retryMessages = messages.map((message) => `${message.role}:${message.content ?? ''}`);
      return { content: '继续后的完整收尾', toolCalls: [], finishReason: 'stop' };
    },
  };
}

test('executeRun: runs the loop across steps and finalizes', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'find json files');

  const published: AgentEvent[] = [];
  await executeRun(run.id, {
    store,
    provider: scriptedProvider(),
    publish: (_id, e) => published.push(e),
    hardStepCap: 5,
    toolSettings: testToolSettings(),
    contextSettings: { modelContextWindow: 50_000, contextBudget: 25_000, contextBudgetSource: 'test-model-settings' },
  });

  const finished = await store.getRun(scope, run.id);
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
  assert.ok(usage.every((e) => e.estContextTokens !== undefined && e.contextBudget === 25_000));
  const stats = published.filter((e): e is Extract<AgentEvent, { type: 'stream_stats' }> => e.type === 'stream_stats');
  assert.ok(stats.some((e) => e.totals.outputChars >= 'all done'.length));
  assert.ok(stats.some((e) => e.totals.toolInputChars > 0));
  assert.ok(stats.some((e) => e.totals.toolOutputChars > 0));

  // 对话会持久化为：用户消息、glob 的 assistant/tool 消息、最终 assistant 消息。
  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
});

test('executeRun: 使用 run 的空间配置副本装配提示词、工具和上下文预算', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const observed: { systemPrompt: string; tools: string[] } = { systemPrompt: '', tools: [] };
  const provider: Provider = {
    name: 'space-snapshot',
    async complete(messages, tools) {
      observed.systemPrompt = messages.find((message) => message.role === 'system')?.content ?? '';
      observed.tools = tools.map((tool) => tool.name);
      return { content: 'snapshot applied', toolCalls: [], finishReason: 'stop' };
    },
  };
  const run = await store.createRun(scope, thread.id, 'use snapshot', {
    modelRef: 'main:model-a',
    spaceConfigSnapshot: {
      schemaVersion: 1,
      spaceId: thread.space_id,
      mode: 'web',
      systemPrompt: 'SPACE-SNAPSHOT-MARKER',
      model: {
        modelRef: 'main:model-a',
        allowedModelRefs: ['main:model-a'],
        contextWindow: 40_000,
        contextBudget: 12_345,
        contextBudgetSource: 'space-config',
      },
      capabilities: { tools: ['file_read'], mcpServers: [], runtime: [] },
      external: { allowTrustedPrompt: false, allowNextStep: false },
    },
    runtimeCapabilitiesSnapshot: {
      allowedCapabilities: [],
      llm: { enabled: false, defaultModelId: '', models: [] },
      image: { enabled: false, defaultModelId: '', models: [] },
      video: { enabled: false, defaultModelId: '', models: [] },
    },
  });
  const published: AgentEvent[] = [];
  await executeRun(run.id, {
    store,
    provider,
    publish: (_id, event) => published.push(event),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.match(observed.systemPrompt, /SPACE-SNAPSHOT-MARKER/);
  assert.deepEqual(observed.tools, ['file_read']);
  const usage = published.find((event): event is Extract<AgentEvent, { type: 'usage_update' }> => event.type === 'usage_update');
  assert.equal(usage?.contextBudget, 12_345);
});

test('executeRun: 按 plugin_lock 装配并激活 tenant 业务 Skill', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'runforge-executor-business-source-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-executor-business-workspace-'));
  const pluginRoot = join(sourceRoot, scope.tenantId, 'crm');
  const skillRoot = join(pluginRoot, 'skills', 'customer-query');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), [
    '---',
    'name: customer-query',
    'description: Query the reviewed tenant CRM.',
    '---',
    '# Customer query instructions',
  ].join('\n'));
  await writeFile(join(pluginRoot, 'runforge.plugin.yaml'), [
    'schemaVersion: 1',
    'id: crm',
    'description: CRM business plugin.',
    'skills:',
    '  - id: customer-query',
    '    path: skills/customer-query',
  ].join('\n'));

  const registry = new BusinessPluginRegistry([sourceRoot]);
  const [definition] = await registry.list(scope.tenantId);
  assert.ok(definition);
  const runtime = new BusinessPluginRuntimeService();
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const lock = createSpaceRuntimeLock({
    tenantId: scope.tenantId,
    spaceId: thread.space_id,
    configVersion: 1,
    plugins: [createBusinessPluginSelection(definition)],
  });
  const run = await store.createRun(scope, thread.id, 'query customer', {
    modelRef: 'main:model-a',
    pluginLock: lock,
    spaceConfigSnapshot: {
      schemaVersion: 1,
      spaceId: thread.space_id,
      mode: 'web',
      systemPrompt: '',
      model: {
        modelRef: 'main:model-a',
        allowedModelRefs: ['main:model-a'],
        contextWindow: 40_000,
        contextBudget: 20_000,
        contextBudgetSource: 'space-config',
      },
      capabilities: { tools: ['skill_activate'], mcpServers: [], businessPlugins: ['crm'], runtime: [] },
      external: { allowTrustedPrompt: false, allowNextStep: false },
    },
  });
  let turn = 0;
  let sawCatalog = false;
  let sawInstructions = false;
  try {
    await executeRun(run.id, {
      store,
      provider: {
        name: 'business-skill',
        async complete(messages) {
          turn += 1;
          if (turn === 1) {
            sawCatalog = messages.some((message) => message.content?.includes('business:crm/customer-query'));
            return {
              content: null,
              toolCalls: [{ id: 'business_skill', name: 'skill_activate', arguments: '{"id":"business:crm/customer-query"}' }],
            };
          }
          sawInstructions = messages.some((message) => message.role === 'tool' && message.content?.includes('# Customer query instructions'));
          return { content: 'business skill done', toolCalls: [] };
        },
      },
      publish: () => {},
      hardStepCap: 3,
      toolSettings: testToolSettings({ workspaceRoot }),
      businessPluginRegistry: registry,
      businessPluginRuntime: runtime,
      businessPluginSecretResolver: async () => ({}),
    });
    assert.equal((await store.getRun(scope, run.id))?.status, 'done');
    assert.equal(sawCatalog, true);
    assert.equal(sawInstructions, true);
    assert.equal((await store.getEvents(scope, run.id)).some((event) => (
      event.type === 'skill_activated' && event.skillId === 'business:crm/customer-query'
    )), true);
  } finally {
    await runtime.dispose();
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('executeRun: external 空间即使模型伪造 ask_user 调用也不会进入等待状态', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  let turn = 0;
  let observedSystemPrompt = '';
  const provider: Provider = {
    name: 'external-ask-user-guard',
    async complete(messages) {
      observedSystemPrompt = messages.find((message) => message.role === 'system')?.content ?? '';
      turn += 1;
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{ id: 'call_external_ask', name: 'ask_user', arguments: '{"question":"继续吗？"}' }],
          finishReason: 'tool-calls',
        };
      }
      return { content: '按合理假设完成', toolCalls: [], finishReason: 'stop' };
    },
  };
  const run = await store.createRun(scope, thread.id, 'external input', {
    modelRef: 'main:model-a',
    spaceConfigSnapshot: {
      schemaVersion: 1,
      spaceId: thread.space_id,
      mode: 'external',
      systemPrompt: '',
      model: {
        modelRef: 'main:model-a',
        allowedModelRefs: ['main:model-a'],
        contextWindow: 40_000,
        contextBudget: 20_000,
        contextBudgetSource: 'space-config',
      },
      capabilities: { tools: ['file_read'], mcpServers: [], runtime: [] },
      external: {
        allowTrustedPrompt: true,
        allowNextStep: false,
        trustedPrompt: 'TRUSTED-CALLER-MARKER',
      },
    },
    runtimeCapabilitiesSnapshot: {
      allowedCapabilities: [],
      llm: { enabled: false, defaultModelId: '', models: [] },
      image: { enabled: false, defaultModelId: '', models: [] },
      video: { enabled: false, defaultModelId: '', models: [] },
    },
  });
  const published: AgentEvent[] = [];
  await executeRun(run.id, {
    store,
    provider,
    publish: (_id, event) => published.push(event),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.equal((await store.getRun(scope, run.id))?.status, 'done');
  assert.match(observedSystemPrompt, /TRUSTED-CALLER-MARKER/);
  assert.equal(published.some((event) => event.type === 'user_question'), false);
  assert.ok(published.some((event) => event.type === 'tool_result' && /未被当前 run 的空间配置授权/.test(event.result)));
});

test('executeRun: 正常结束前原子吸收 next_step 输入并继续下一轮', async () => {
  const store = new NextStepMemoryStore();
  const thread = await store.createThread(scope);
  let runId = '';
  let turn = 0;
  let secondTurnSawInput = false;
  let firstTurnSawArtifact = false;
  let materializations = 0;
  const provider: Provider = {
    name: 'external-next-step',
    async complete(messages) {
      turn += 1;
      assert.equal(materializations, turn, 'provider 调用前应完成当前输入的 artifact materialize');
      if (turn === 1) {
        firstTurnSawArtifact = messages.some((message) => message.role === 'user' && message.content?.includes('ar_executor_input'));
        await store.enqueue(scope, runId, '请同时补充回滚方案');
        return { content: '第一版结果', toolCalls: [], finishReason: 'stop' };
      }
      secondTurnSawInput = messages.some((message) => message.role === 'user' && message.content === '请同时补充回滚方案');
      return { content: '已补充回滚方案的最终结果', toolCalls: [], finishReason: 'stop' };
    },
  };
  const run = await store.createRun(scope, thread.id, '制定发布方案', {
    modelRef: 'main:model-a',
    spaceConfigSnapshot: {
      schemaVersion: 1,
      spaceId: thread.space_id,
      mode: 'external',
      systemPrompt: '',
      model: {
        modelRef: 'main:model-a',
        allowedModelRefs: ['main:model-a'],
        contextWindow: 40_000,
        contextBudget: 20_000,
        contextBudgetSource: 'space-config',
      },
      capabilities: { tools: [], mcpServers: [], runtime: [] },
      external: { allowTrustedPrompt: false, allowNextStep: true },
    },
  });
  runId = run.id;

  const published: AgentEvent[] = [];
  await executeRun(run.id, {
    store,
    provider,
    publish: (_id, event) => published.push(event),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
    materializeRunArtifacts: async () => {
      materializations += 1;
      return [{ id: 'ar_executor_input', name: 'input.txt', mimeType: 'text/plain', size: 5 }];
    },
  });

  const finished = await store.getRun(scope, run.id);
  assert.equal(turn, 2);
  assert.equal(materializations, 2);
  assert.equal(firstTurnSawArtifact, true);
  assert.equal(secondTurnSawInput, true);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, '已补充回滚方案的最终结果');
  assert.equal(finished?.external_input_open, false);
  assert.equal(published.filter((event) => event.type === 'external_input_applied').length, 1);
  const persistedMessages = (await store.loadRawThreadMessages(scope, thread.id, { runId: run.id }))
    .map((message) => [message.role, message.content]);
  assert.match(persistedMessages[0]?.[1] ?? '', /ar_executor_input/);
  assert.deepEqual(
    persistedMessages.slice(1),
    [
      ['assistant', '第一版结果'],
      ['user', '请同时补充回滚方案'],
      ['assistant', '已补充回滚方案的最终结果'],
    ],
  );
});

test('thread title: uses first input as fallback and generates for an empty-title branch', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '修复登录页提交后没有响应的问题');
  assert.equal((await store.listThreads(scope))[0]?.fallback_title, '修复登录页提交后没有响应的问题');
  await store.setRunStatus(scope, run.id, 'done', { output: '已经从表单提交链路修复根因。' });

  const updated = await maybeGenerateThreadTitleAfterFirstRun(scope, run.id, {
    store,
    provider: {
      name: 'title-provider',
      async complete() {
        return { content: '登录提交无响应修复', toolCalls: [] };
      },
    },
  });

  assert.equal(updated?.title, '登录提交无响应修复');

  const titledRun = await store.createRun(scope, thread.id, '继续优化样式');
  await store.setRunStatus(scope, titledRun.id, 'done', { output: 'done' });
  const skipped = await maybeGenerateThreadTitleAfterFirstRun(scope, titledRun.id, {
    store,
    provider: {
      name: 'unused-title-provider',
      async complete() {
        throw new Error('第二轮不应该生成标题');
      },
    },
  });
  assert.equal(skipped, null);
  assert.equal((await store.getThread(scope, thread.id))?.title, '登录提交无响应修复');

  const untitledThread = await store.createThread(scope);
  const firstRun = await store.createRun(scope, untitledThread.id, '杭州到余姚这一块，夏天玩水或者漂流都有哪些地方可以玩');
  await store.setRunStatus(scope, firstRun.id, 'done', { output: '沿线有多个玩水点。' });
  const secondRun = await store.createRun(scope, untitledThread.id, '我的意思是这一块找一个地方玩，而不是一路玩过去');
  assert.equal((await store.getThread(scope, untitledThread.id))?.fallback_title, '杭州到余姚这一块，夏天玩水或者漂流都有哪些地方可以玩');
  await store.setRunStatus(scope, secondRun.id, 'done', { output: '更适合选余姚四明山一带。' });
  const backfilled = await maybeGenerateThreadTitleAfterFirstRun(scope, secondRun.id, {
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
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '请帮我分析跨平台对话模型优化方案，以及后续落地建议');
  await store.setRunStatus(scope, run.id, 'done', { output: '建议从上下文、路由和评估三个方向优化。' });

  const updated = await maybeGenerateThreadTitleAfterFirstRun(scope, run.id, {
    store,
    provider: {
      name: 'verbose-title-provider',
      async complete() {
        return { content: '请帮我分析跨平台对话模型优化方案，以及后续落地建议', toolCalls: [] };
      },
    },
  });

  assert.equal(updated?.title, '跨平台对话模型优化方案');

  const fallbackThread = await store.createThread(scope);
  const fallbackRun = await store.createRun(scope, fallbackThread.id, '楼下50米洗车，建议直接开车还是走路');
  await store.setRunStatus(scope, fallbackRun.id, 'done', { output: '建议直接走路。' });

  const fallback = await maybeGenerateThreadTitleAfterFirstRun(scope, fallbackRun.id, {
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
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '整理Ubuntu 24安装NVIDIA驱动的步骤');
  await store.setRunStatus(scope, run.id, 'done', { output: '按驱动版本和安全启动状态拆分步骤。' });

  const updated = await maybeGenerateThreadTitleAfterFirstRun(scope, run.id, {
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
  const observations = new MemoryProviderObservationRepository();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '规划一次杭州周边漂流');
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
    providerRunner: new ProviderRunner(observations, null),
  });

  await waitUntil(async () => (await store.getThread(scope, thread.id))?.title === '杭州周边漂流规划');
  assert.equal((await store.getThread(scope, thread.id))?.title, '杭州周边漂流规划');
  assert.equal(calls, 2);
  assert.deepEqual(
    [...observations.invocations.values()].map((item) => item.purpose),
    ['agent', 'title'],
  );
});

test('executeRun: persists streamed text and terminal stream status for replay', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'stream a final answer');
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

  const events = await store.getEvents(scope, run.id);
  const textEvents = events.filter((e): e is Extract<AgentEvent, { type: 'llm_delta' }> => e.type === 'llm_delta');
  assert.deepEqual(textEvents.map((e) => e.text), ['he', 'llo']);
  assert.equal(textEvents.map((e) => e.text).join(''), 'hello');
  assert.equal(events.filter((e) => e.type === 'reasoning').length, 1);
  assert.ok(events.some((e) => e.type === 'reasoning_timing'));
  assert.ok(events.some((e) => e.type === 'stream_stats' && e.stage === 'done' && e.totals.outputChars === 5));
  assert.equal(events.at(-1)?.type, 'final');
  assert.ok(published.some((e) => e.type === 'llm_delta' && e.text === 'he'));
});

test('executeRun: retries a pre-delta stream failure without switching to non-streaming', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '重试流式传输');
  const published: AgentEvent[] = [];
  let streamCalls = 0;

  const warnings = await captureWarnings(async () => {
    await executeRun(run.id, {
      store,
      provider: {
        name: 'stream-only',
        async complete() {
          assert.fail('流式重试不应改走非流式 complete');
        },
        async completeStream(_messages, _tools, onDelta) {
          streamCalls += 1;
          if (streamCalls === 1) throw new Error('first stream request failed');
          onDelta({ content: 'recovered' });
          return { content: 'recovered', toolCalls: [] };
        },
      },
      publish: (_id, event) => published.push(event),
      hardStepCap: 3,
      stream: true,
      toolSettings: testToolSettings(),
    });
  });

  const events = await store.getEvents(scope, run.id);
  assert.equal(streamCalls, 2);
  assert.equal((await store.getRun(scope, run.id))?.status, 'done');
  assert.ok(events.some((event) => event.type === 'stream_retry' && event.message === 'first stream request failed'));
  assert.equal(published.some((event) => event.type === 'stream_retry'), false);
  assert.ok(published.some((event) => event.type === 'llm_delta' && event.text === 'recovered'));
  assert.ok(warnings.some((line) => line.includes('首个增量前失败') && line.includes('first stream request failed')));
});

test('executeRun: injects the current workspace root into the LLM context', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'clone a repo');
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
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'check datasource env', {
    runtimeCapabilitiesSnapshot: {
      allowedCapabilities: ['datasource.credentials'],
      llm: { enabled: false, defaultModelId: '', models: [] },
      image: { enabled: false, defaultModelId: '', models: [] },
      video: { enabled: false, defaultModelId: '', models: [] },
    },
  });
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
            && (message.content ?? '').includes('WORKLOAD_TOKEN=已注入')
          ));
          return {
            content: null,
            toolCalls: [{
              id: 'skill_1',
              name: 'skill_activate',
              arguments: '{"id":"builtin:database-access"}',
            }],
          };
        }
        sawSkillReusedRunEnv = messages.some((message) => (
          message.role === 'tool'
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
        WORKLOAD_TOKEN: 'wlt_test_runtime',
        RUNFORGE_RUNTIME_API_BASE: 'http://localhost:8080/api/runtime',
        DATASOURCE_ID: 'ds_test',
        DATASOURCE_PROFILE: 'readonly',
      },
      summary: [
        '数据库访问运行环境（run 级）:',
        '- WORKLOAD_TOKEN=已注入',
        '- DATASOURCE_ID=ds_test',
      ].join('\n'),
    }),
  });

  assert.equal(sawRuntimeContext, true);
  assert.equal(sawSkillReusedRunEnv, true);
});

test('executeRun: activates a skill while native tools remain loaded', async () => {
  const skillRoot = join(testWorkspace, '.skills', 'sample-skill');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    [
      '---',
      'name: sample-skill',
      'description: Use when a test needs a tiny skill.',
      '---',
      '',
      '# Sample Skill',
      '',
      'Read `references/details.md` only when needed.',
    ].join('\n'),
    'utf8',
  );

  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'use a skill');
  const published: AgentEvent[] = [];
  const toolNamesByTurn: string[][] = [];
  let firstSystemText = '';
  let firstUserText = '';
  let secondSystemText = '';
  let secondToolText = '';
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
          firstUserText = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
          return {
            content: null,
            toolCalls: [
              { id: 'skill_1', name: 'skill_activate', arguments: '{"id":"user:sample-skill"}' },
              { id: 'read_1', name: 'file_read', arguments: JSON.stringify({ path: join(skillRoot, 'SKILL.md') }) },
            ],
          };
        }
        secondSystemText = systemText;
        secondToolText = messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '').join('\n');
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: (_id, e) => published.push(e),
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.doesNotMatch(firstSystemText, /user:sample-skill: Use when a test needs a tiny skill/);
  assert.match(firstUserText, /user:sample-skill: Use when a test needs a tiny skill/);
  assert.match(firstUserText, /用户请求 \/ User request:\nuse a skill/);
  assert.match(secondSystemText, /user:sample-skill/);
  assert.match(secondSystemText, /root=/);
  assert.doesNotMatch(secondSystemText, /# Sample Skill/);
  assert.match(secondToolText, /# Sample Skill/);
  assert.ok(toolNamesByTurn[0].includes('shell'));
  assert.ok(toolNamesByTurn[0].includes('skill_activate'));
  assert.ok(toolNamesByTurn[1].includes('file_read'));
  assert.ok(toolNamesByTurn[1].includes('skill_activate'));
  assert.ok(toolNamesByTurn[1].includes('shell'));
  const activated = published.find((e) => e.type === 'skill_activated');
  assert.equal(activated?.type, 'skill_activated');
  assert.equal(activated?.type === 'skill_activated' ? activated.name : '', 'sample-skill');
  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(msgs[0].content, 'use a skill');
  assert.equal(msgs[2].toolCallId, 'skill_1');
  assert.equal(msgs[2].collapsed, 'masked');
  assert.doesNotMatch(msgs[2].content ?? '', /# Sample Skill/);
  assert.equal(msgs[3].toolCallId, 'read_1');
  assert.equal(msgs.some((m) => m.role === 'system' && (m.content ?? '').includes('已激活 Skill')), false);
  assert.equal(published.some((event) => event.type === 'compaction' && event.reason === 'skill-activation-consumed'), true);
  assert.equal((await store.getRun(scope, run.id))?.status, 'done');
});

test('executeRun: skill catalog uses folded YAML descriptions in user prompt without persisting them', async () => {
  const skillRoot = join(testWorkspace, '.skills', 'ppt-master');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    [
      '---',
      'name: ppt-master',
      'description: >',
      '  AI-driven multi-format SVG content generation system.',
      '  Use when user asks to "create PPT", "make presentation",',
      '  "生成PPT", "做PPT", or mentions "ppt-master".',
      '---',
      '',
      '# PPT Master Skill',
    ].join('\n'),
    'utf8',
  );

  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '测试：做一个example ppt');
  let userText = '';

  await executeRun(run.id, {
    store,
    provider: {
      name: 'capture-skill-catalog',
      async complete(messages) {
        userText = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.match(userText, /user:ppt-master: AI-driven multi-format SVG content generation system\. Use when user asks/);
  assert.match(userText, /生成PPT/);
  assert.doesNotMatch(userText, /ppt-master: >/);
  assert.match(userText, /用户请求 \/ User request:\n测试：做一个example ppt/);
  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.equal(msgs[0].content, '测试：做一个example ppt');
});

test('executeRun: resumed runs still expose the skill catalog before the persisted user message', async () => {
  const skillRoot = join(testWorkspace, '.skills', 'resume-skill');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    ['---', 'name: resume-skill', 'description: Use when checking resumed prompt context.', '---', '', '# Resume Skill'].join('\n'),
    'utf8',
  );

  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'resume needs skill list');
  await store.addMessage(scope, thread.id, run.id, null, { role: 'user', content: 'resume needs skill list' });
  let userText = '';

  await executeRun(run.id, {
    store,
    provider: {
      name: 'capture-resumed-skill-catalog',
      async complete(messages) {
        userText = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.match(userText, /user:resume-skill: Use when checking resumed prompt context/);
  assert.match(userText, /用户请求 \/ User request:\nresume needs skill list/);
  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.equal(msgs[0].content, 'resume needs skill list');
});

test('executeRun: skill activation instructions do not leak into the next run history', async () => {
  const skillRoot = join(testWorkspace, '.skills', 'leaky-skill');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    ['---', 'name: leaky-skill', 'description: Use in leakage tests.', '---', '', '# Leaky Skill'].join('\n'),
    'utf8',
  );

  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run1 = await store.createRun(scope, thread.id, 'activate skill');
  let turn = 0;
  await executeRun(run1.id, {
    store,
    provider: {
      name: 'activate-then-finish',
      async complete() {
        turn += 1;
        if (turn === 1) return { content: null, toolCalls: [{ id: 'skill_1', name: 'skill_activate', arguments: '{"id":"user:leaky-skill"}' }] };
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  const run2 = await store.createRun(scope, thread.id, 'new run');
  let secondRunSystemText = '';
  let secondRunContext = '';
  await executeRun(run2.id, {
    store,
    provider: {
      name: 'capture-next-run',
      async complete(messages) {
        secondRunSystemText = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
        secondRunContext = messages.map((m) => m.content ?? '').join('\n');
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  assert.match(secondRunSystemText, /Skills: none/);
  assert.equal(secondRunSystemText.includes('# Leaky Skill'), false);
  assert.equal(secondRunContext.includes('# Leaky Skill'), false);
});

test('executeRun: MCP tools load only after current-run activation and unload in the next run', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const mcpSettings = {
    servers: [{
      id: 'browser',
      label: 'Browser MCP',
      description: '控制真实浏览器完成页面操作。',
      enabled: true,
      url: 'https://example.com/mcp',
      bearerToken: '',
      headers: [],
      timeoutMs: 60_000,
      maxOutput: 40_000,
    }],
  };
  const extraTools = Array.from({ length: 80 }, (_, index) => ({
    serverId: 'browser',
    serverLabel: 'Browser MCP',
    originalName: `browser_tool_${index}_${'x'.repeat(20)}`,
    mappedName: `mcp__browser__browser_tool_${index}_${'x'.repeat(20)}`,
    description: `浏览器工具 ${index}`,
    parameters: { type: 'object' },
  }));
  const mcpToolLoader = async () => ({
    server: mcpSettings.servers[0],
    tools: [{
      serverId: 'browser',
      serverLabel: 'Browser MCP',
      originalName: 'open_page',
      mappedName: 'mcp__browser__open_page',
      description: '打开页面',
      parameters: { type: 'object', properties: { url: { type: 'string' } } },
    }, ...extraTools],
  });

  const run1 = await store.createRun(scope, thread.id, '使用浏览器');
  const run1Tools: string[][] = [];
  let run1UserText = '';
  let run1SystemText = '';
  let activationResult = '';
  let turn = 0;
  await executeRun(run1.id, {
    store,
    provider: {
      name: 'mcp-activation',
      async complete(messages, tools) {
        turn += 1;
        run1Tools.push(tools.map((tool) => tool.name));
        if (turn === 1) {
          run1UserText = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
          return { content: null, toolCalls: [{ id: 'mcp_1', name: 'mcp_activate', arguments: '{"id":"browser"}' }] };
        }
        run1SystemText = messages.filter((message) => message.role === 'system').map((message) => message.content ?? '').join('\n');
        activationResult = messages.find((message) => message.role === 'tool' && message.toolCallId === 'mcp_1')?.content ?? '';
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings({ maxOutput: 1_000 }),
    mcpSettings,
    mcpToolLoader,
  });

  assert.match(run1UserText, /browser: 控制真实浏览器完成页面操作/);
  assert.equal(run1Tools[0].includes('mcp__browser__open_page'), false);
  assert.equal(run1Tools[0].includes('mcp_activate'), true);
  assert.equal(run1Tools[1].includes('mcp__browser__open_page'), true);
  assert.match(run1SystemText, /MCP: browser/);
  assert.equal(activationResult.length, 1_000);
  assert.match(activationResult, /工具策略已截断/);
  assert.equal((await store.getEvents(scope, run1.id)).some((event) => event.type === 'mcp_activated' && event.serverId === 'browser'), true);

  const run2 = await store.createRun(scope, thread.id, '下一轮不使用浏览器');
  let run2Tools: string[] = [];
  let run2SystemText = '';
  await executeRun(run2.id, {
    store,
    provider: {
      name: 'mcp-unloaded',
      async complete(messages, tools) {
        run2Tools = tools.map((tool) => tool.name);
        run2SystemText = messages.filter((message) => message.role === 'system').map((message) => message.content ?? '').join('\n');
        return { content: 'done', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 2,
    toolSettings: testToolSettings(),
    mcpSettings,
    mcpToolLoader,
  });

  assert.equal(run2Tools.includes('mcp__browser__open_page'), false);
  assert.match(run2SystemText, /MCP: none/);
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
  const observations = new MemoryProviderObservationRepository();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'delegate review');
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
    providerRunner: new ProviderRunner(observations, null),
  });

  const started = published.find((e) => e.type === 'subagent_started');
  assert.equal(started?.type, 'subagent_started');
  assert.equal(started?.type === 'subagent_started' ? started.stageId : '', 'review');
  assert.deepEqual(started?.type === 'subagent_started' ? started.skillNames : [], ['review-skill']);
  assert.equal((await store.getRun(scope, run.id))?.status, 'done');

  let msgs = await store.loadThreadMessages(scope, thread.id);
  const subagentStartResult = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'sub_1')?.content ?? '';
  assert.match(subagentStartResult, /subagentRunId: sr_/);
  assert.match(subagentStartResult, /status: running/);
  assert.doesNotMatch(subagentStartResult, /没有发现阻塞风险/);

  await waitUntil(() => published.filter((e) => e.type === 'subagent_finished').length === 2);
  assert.match(subagentPrompts.join('\n'), /# Review Skill/);
  const rows = await store.listSubagentRunsByThread(scope, thread.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.status === 'done'), true);
  assert.match(rows[0].output ?? '', /没有发现阻塞风险/);
  const purposes = [...observations.invocations.values()].map((item) => item.purpose);
  assert.equal(purposes.filter((purpose) => purpose === 'agent').length, 2);
  assert.equal(purposes.filter((purpose) => purpose === 'subagent').length, 2);

  const run2 = await store.createRun(scope, thread.id, 'poll previous subagent');
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

  assert.equal((await store.getRun(scope, run2.id))?.status, 'done');
  msgs = await store.loadThreadMessages(scope, thread.id);
  const pollResult = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'poll_1')?.content ?? '';
  assert.match(pollResult, /status: done/);
  assert.match(pollResult, /没有发现阻塞风险/);
});

test('executeRun: writer subagent can use scheduled write tools and poll waits for completion', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'delegate writer');
  const outputPath = join(testWorkspace, 'writer-subagent.txt');
  let parentTurn = 0;
  let writerTurn = 0;

  await executeRun(run.id, {
    store,
    provider: {
      name: 'writer-subagent',
      async complete(messages) {
        const prompt = messages.map((m) => m.content ?? '').join('\n');
        if (prompt.includes('异步 writer subagent')) {
          writerTurn += 1;
          if (writerTurn === 1) {
            return {
              content: null,
              toolCalls: [{
                id: 'write_1',
                name: 'file_write',
                arguments: JSON.stringify({ path: outputPath, content: 'writer subagent output\n' }),
              }],
            };
          }
          return { content: `writer file done: ${outputPath}`, toolCalls: [] };
        }

        parentTurn += 1;
        if (parentTurn === 1) {
          return {
            content: null,
            toolCalls: [{
              id: 'sub_1',
              name: 'subagent_run',
              arguments: JSON.stringify({
                runtimeProfileId: 'writer',
                task: '创建 writer-subagent.txt。',
                expectedOutput: '返回产物路径。',
              }),
            }],
          };
        }

        const history = messages.map((m) => m.content ?? '').join('\n');
        const subagentRunId = history.match(/subagentRunId: (sr_[A-Za-z0-9]+)/)?.[1];
        if (parentTurn === 2 && subagentRunId) {
          return {
            content: null,
            toolCalls: [{ id: 'poll_1', name: 'subagent_poll', arguments: JSON.stringify({ subagentRunId, waitSeconds: 2 }) }],
          };
        }

        return { content: '已确认 writer subagent 产物。', toolCalls: [] };
      },
    },
    publish: () => {},
    hardStepCap: 6,
    toolSettings: testToolSettings(),
  });

  assert.equal((await store.getRun(scope, run.id))?.status, 'done');
  assert.equal(await readFile(outputPath, 'utf8'), 'writer subagent output\n');
  const rows = await store.listSubagentRunsByThread(scope, thread.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runtime_profile_id, 'writer');
  assert.equal(rows[0].status, 'done');
  assert.match(rows[0].output ?? '', /工具执行摘要 \/ Tool execution summary:/);
  assert.match(rows[0].output ?? '', /file_write/);

  const msgs = await store.loadThreadMessages(scope, thread.id);
  const pollResult = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'poll_1')?.content ?? '';
  assert.match(pollResult, /status: done/);
  assert.match(pollResult, /writer file done:/);
  assert.doesNotMatch(pollResult, /等待 2 秒后仍未完成/);
});

test('executeRun: repeated running subagent polls do not trigger loop guard', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'wait for slow subagent');
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

  assert.equal((await store.getRun(scope, run.id))?.status, 'done');
  assert.equal(published.some((event) => event.type === 'progress_stalled'), false);
  const pollResults = (await store.loadThreadMessages(scope, thread.id)).filter((msg) => msg.role === 'tool' && msg.toolCallId?.startsWith('poll_'));
  assert.equal(pollResults.some((msg) => /\bstatus: running\b/.test(msg.content ?? '')), true);
  assert.equal(pollResults.some((msg) => /\bstatus: done\b/.test(msg.content ?? '')), true);
});

test('executeRun: streams tool input stats without double counting final tool args', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'update plan via streamed tool args');
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
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'write a final report and close the plan');
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

  const finished = await store.getRun(scope, run.id);
  assert.equal(turns, 2);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, finalText);
  assert.equal(finished?.goal_state?.phase, 'completed');
  assert.equal(published.some((event) => event.type === 'final' && event.output === finalText), true);
  assert.equal(published.some((event) => event.type === 'final' && event.output === sameTurnText), false);

  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[1]?.content, sameTurnText);
  assert.equal(msgs[2]?.toolCallId, 'plan_done');
  assert.equal(msgs[3]?.content, finalText);
});

test('executeRun: auto-completes the final report plan item without a second summary turn', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'produce a report');
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

  const finished = await store.getRun(scope, run.id);
  assert.equal(turns, 2);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, finalText);
  assert.deepEqual(finished?.goal_state?.plan.map((item) => item.status), ['done', 'done']);
  assert.equal(published.some((event) => event.type === 'final' && event.output === finalText), true);
});

test('executeRun: final text closes the run even when plan is still open', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'produce then close plan');
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

  const finished = await store.getRun(scope, run.id);
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
  const thread = await store.createThread(scope);

  const run1 = await store.createRun(scope, thread.id, 'first');
  await executeRun(run1.id, {
    store,
    provider: { name: 's', async complete() { return { content: 'ok1', toolCalls: [] }; } },
    publish: () => {},
    hardStepCap: 3,
    toolSettings: testToolSettings(),
  });

  // Second run should see the first run's messages as prior context.
  let seenPriorCount = 0;
  const run2 = await store.createRun(scope, thread.id, 'second');
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
    const thread = await store.createThread(scope);
    const oldRun = await store.createRun(scope, thread.id, 'old');
    const bigArgs = JSON.stringify({ path: 'generated/old.txt', content: 'r'.repeat(3000) });
    await store.addMessage(scope, thread.id, oldRun.id, null, {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'file-old', name: 'file_write', arguments: bigArgs }],
    });
    await store.addMessage(scope, thread.id, oldRun.id, null, { role: 'tool', content: 'x'.repeat(4000), toolCallId: 'file-old' });
    await store.setRunStatus(scope, oldRun.id, 'done');

    const run = await store.createRun(scope, thread.id, 'new');
    const published: AgentEvent[] = [];
    await executeRun(run.id, {
      store,
      provider: { name: 's', async complete() { return { content: 'ok', toolCalls: [] }; } },
      publish: (_id, e) => published.push(e),
      hardStepCap: 3,
      toolSettings: testToolSettings(),
    });

    const msgs = await store.loadThreadMessages(scope, thread.id);
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

test('executeRun: records L3 summary and main model calls as separate provider purposes', async () => {
  const { keepRecentMessages } = config.agent;
  config.agent.keepRecentMessages = 2;
  try {
    const store = new MemoryStore();
    const observations = new MemoryProviderObservationRepository();
    const thread = await store.createThread(scope);
    const oldRun = await store.createRun(scope, thread.id, 'old anchor');
    for (let index = 0; index < 8; index += 1) {
      await store.addMessage(scope, thread.id, oldRun.id, null, {
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `history-${index}-${'x'.repeat(1200)}`,
      });
    }
    await store.setRunStatus(scope, oldRun.id, 'done');

    const run = await store.createRun(scope, thread.id, 'new request');
    await executeRun(run.id, {
      store,
      provider: {
        name: 'summary-aware',
        async complete(messages) {
          const summaryPrompt = messages.some((message) => message.content?.includes('需要摘要的旧上下文'));
          return summaryPrompt
            ? { content: '压缩后的历史摘要', toolCalls: [] }
            : { content: 'done', toolCalls: [] };
        },
      },
      providerRunner: new ProviderRunner(observations, null),
      publish: () => {},
      hardStepCap: 3,
      contextSettings: {
        modelContextWindow: 10_000,
        contextBudget: 1_000,
        contextBudgetSource: 'test',
      },
      toolSettings: testToolSettings(),
    });

    assert.deepEqual(
      [...observations.invocations.values()].map((item) => item.purpose),
      ['compaction', 'agent'],
    );
  } finally {
    config.agent.keepRecentMessages = keepRecentMessages;
  }
});

test('executeRun: text without tools completes when no plan is open', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'answer directly');

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

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'premature final answer');
});

test('executeRun: non-stop finish reason is surfaced as run error instead of final', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'write a long report');
  const published: AgentEvent[] = [];

  const warnings = await captureWarnings(async () => {
    await executeRun(run.id, {
      store,
      provider: {
        name: 'length-finish',
        async complete() {
          return {
            content: '这是一段被截断的输出',
            toolCalls: [],
            finishReason: 'length',
            rawFinishReason: 'max_output_tokens',
          };
        },
      },
      publish: (_id, e) => published.push(e),
      hardStepCap: 2,
      toolSettings: testToolSettings(),
    });
  });

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'error');
  assert.match(finished?.error ?? '', /模型输出达到上限/);
  assert.equal(published.some((event) => event.type === 'final'), false);
  const error = published.find((event): event is Extract<AgentEvent, { type: 'error' }> => event.type === 'error');
  assert.equal(error?.finishReason, 'length');
  assert.equal(error?.rawFinishReason, 'max_output_tokens');
  assert.equal(warnings.some((line) => line.includes('finishReason=length') && line.includes('rawFinishReason=max_output_tokens')), true);
  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.equal(msgs.at(-1)?.content, '这是一段被截断的输出');
});

test('executeRun: truncated tool-call turn does not execute tools', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'write file');
  const published: AgentEvent[] = [];

  const warnings = await captureWarnings(async () => {
    await executeRun(run.id, {
      store,
      provider: {
        name: 'truncated-tool-call',
        async complete() {
          return {
            content: null,
            toolCalls: [{ id: 'write_1', name: 'file_write', arguments: '{"path":"x.txt","content":"半截' }],
            finishReason: 'length',
            rawFinishReason: 'max_output_tokens',
          };
        },
      },
      publish: (_id, e) => published.push(e),
      hardStepCap: 2,
      toolSettings: testToolSettings(),
    });
  });

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'error');
  assert.equal(published.some((event) => event.type === 'tool_call'), false);
  assert.equal(published.some((event) => event.type === 'tool_result'), false);
  assert.equal(published.some((event) => event.type === 'error' && event.finishReason === 'length'), true);
  assert.equal(warnings.some((line) => line.includes('truncated-tool-call') && line.includes('with 1 tool calls')), true);
});

test('executeRun: streaming length finish is persisted as resumable error', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '请生成一段长总结');
  const published: AgentEvent[] = [];
  const providerState = { retryMessages: [] as string[] };
  const provider = truncatedStreamProvider(providerState);

  const warnings = await captureWarnings(async () => {
    await executeRun(run.id, {
      store,
      provider,
      publish: (_id, event) => published.push(event),
      hardStepCap: 3,
      stream: true,
      toolSettings: testToolSettings(),
    });
  });

  const failed = await store.getRun(scope, run.id);
  assert.equal(failed?.status, 'error');
  assert.match(failed?.error ?? '', /模型输出达到上限/);
  assert.equal(published.some((event) => event.type === 'final'), false);
  assert.equal(published.some((event) => event.type === 'llm_delta' && event.text === '第一段半截'), true);
  assert.equal(published.some((event) => event.type === 'error' && event.finishReason === 'length'), true);
  assert.equal(await store.getLastCompletedStepIndex(scope, run.id), 1);
  assert.equal(warnings.some((line) => line.includes('fake-truncated-stream') && line.includes('finishReason=length')), true);

  await store.setRunStatus(scope, run.id, 'pending', { error: null });
  await executeRun(run.id, {
    store,
    provider,
    publish: (_id, event) => published.push(event),
    hardStepCap: 3,
    stream: true,
    resume: true,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, '继续后的完整收尾');
  assert.ok(providerState.retryMessages.some((message) => message.includes('第一段半截，停在这里')));
  assert.equal(published.some((event) => event.type === 'final' && event.output === '继续后的完整收尾'), true);
});

test('executeRun: stops and errors at the hard step cap', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'loop forever');

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

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'error');
  assert.match(finished?.error ?? '', /hard step cap/);
});

test('executeRun: cancels cooperatively at a step boundary', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'long task');

  // Flip the run to 'canceling' the moment the loop starts its first step, so the
  // top-of-step check observes it and stops before finalizing.
  let turn = 0;
  await executeRun(run.id, {
    store,
    provider: {
      name: 'looper',
      async complete() {
        turn += 1;
        if (turn === 1) await store.setRunStatus(scope, run.id, 'canceling');
        return { content: null, toolCalls: [{ id: 'c', name: 'glob', arguments: '{"pattern":"*"}' }] };
      },
    },
    publish: () => {},
    hardStepCap: 50,
    toolSettings: testToolSettings(),
  });

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'canceled');
});

test('executeRun: ask_user pauses the run and keeps tool pairing intact', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'needs clarification');
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

  const paused = await store.getRun(scope, run.id);
  assert.equal(paused?.status, 'waiting_for_user');
  assert.ok(published.some((e) => e.type === 'user_question' && e.question === '继续吗？'));
  const question = published.find((e) => e.type === 'user_question');
  assert.equal(question?.type === 'user_question' ? question.spec?.mode : undefined, 'single');
  assert.equal(question?.type === 'user_question' ? question.spec?.allowCustom : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.required : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.options[0]?.recommended : undefined, true);
  assert.equal(question?.type === 'user_question' ? question.spec?.options[0]?.required : undefined, true);

  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[2].toolCallId, 'ask_1');
});

test('executeRun: rejects malformed string-wrapped tool args without running the tool', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'write a file');
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
  assert.equal((await store.getRun(scope, run.id))?.output, 'done');
});

test('executeRun: resumes the same run after a user answer without duplicating input', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'needs answer');
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
  await store.addMessage(scope, thread.id, run.id, null, { role: 'user', content: '用户回答：\nA' });
  await store.setRunStatus(scope, run.id, 'pending');
  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, resume: true, toolSettings: testToolSettings() });

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, 'ok');
  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.equal(msgs.filter((m) => m.role === 'user' && m.content === 'needs answer').length, 1);
  assert.ok(msgs.some((m) => m.role === 'user' && m.content?.includes('用户回答')));
});

test('executeRun: retries after interrupted streaming output from durable messages only', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, '请生成一段总结');
  let calls = 0;
  let retryMessages: string[] = [];

  const provider: Provider = {
    name: 'interrupted-stream',
    async complete() {
      throw new Error('不应该回退到非流式 complete');
    },
    async completeStream(messages, _tools, onDelta) {
      calls += 1;
      if (calls === 1) {
        onDelta({ content: '半截输出' });
        throw new Error('network disconnected');
      }
      retryMessages = messages.map((message) => `${message.role}:${message.content ?? ''}`);
      return { content: '继续后的完整结果', toolCalls: [] };
    },
  };

  const warnings = await captureWarnings(async () => {
    await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, stream: true, toolSettings: testToolSettings() });
  });

  const failed = await store.getRun(scope, run.id);
  assert.equal(failed?.status, 'error');
  assert.equal(await store.getLastStepIndex(scope, run.id), 1);
  assert.equal(await store.getLastCompletedStepIndex(scope, run.id), 0);
  assert.equal(warnings.some((line) => line.includes('interrupted-stream') && line.includes('network disconnected')), true);

  await store.setRunStatus(scope, run.id, 'pending', { error: null });
  await executeRun(run.id, { store, provider, publish: () => {}, hardStepCap: 3, stream: true, resume: true, toolSettings: testToolSettings() });

  const finished = await store.getRun(scope, run.id);
  assert.equal(finished?.status, 'done');
  assert.equal(finished?.output, '继续后的完整结果');
  assert.deepEqual(retryMessages.filter((message) => message.includes('半截输出')), []);
  const msgs = await store.loadThreadMessages(scope, thread.id);
  assert.equal(msgs.filter((message) => message.role === 'user' && message.content === '请生成一段总结').length, 1);
  assert.equal(msgs.at(-1)?.content, '继续后的完整结果');
});

test('memory store: deleteThread removes dependent run data', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread(scope);
  const run = await store.createRun(scope, thread.id, 'delete me');
  await store.addMessage(scope, thread.id, run.id, null, { role: 'user', content: 'delete me' });
  await store.addEvent(scope, run.id, null, { type: 'final', step: 1, output: 'done' });
  const session = await store.createShellSession(scope, { threadId: thread.id, name: 'Default', owner: 'system', workspaceRoot: '/tmp/ws', backend: 'none' });
  const command = await store.createShellCommand(scope, {
    sessionId: session.id,
    runId: run.id,
    actor: 'agent',
    command: 'printf ok',
    cwd: '/tmp/ws',
    waitMode: 'foreground',
  });
  await store.appendShellCommandLog(scope, command.id, 'stdout', 'ok');

  assert.equal(await store.deleteThread(scope, thread.id), true);
  assert.equal(await store.getThread(scope, thread.id), null);
  assert.deepEqual(await store.listRuns(scope, thread.id), []);
  assert.deepEqual(await store.loadThreadMessages(scope, thread.id), []);
  assert.deepEqual(await store.getEvents(scope, run.id), []);
  assert.deepEqual(await store.listShellSessions(scope, thread.id), []);
  assert.deepEqual(await store.getShellCommand(scope, command.id), null);
  assert.deepEqual(await store.getShellCommandLogs(scope, command.id), []);
});
