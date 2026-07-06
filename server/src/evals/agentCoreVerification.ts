import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { executeRun } from '../agent/executor.js';
import { pool, query } from '../db/pool.js';
import { PgStore } from '../store/pgStore.js';
import type { AgentEvent } from '../agent/types.js';
import type { LlmMessage } from '../llm/types.js';
import type { Store, ThreadRow } from '../store/types.js';
import { getToolSettings, type ToolSettings } from '../settings.js';

const execFileAsync = promisify(execFile);

const TOOL_ALLOW = ['file_read', 'file_write', 'file_edit', 'glob', 'grep', 'shell', 'update_plan'];
const VERIFY_ROOT = resolve(process.cwd(), '../workspace/agent-core-verification');

interface VerifyContext {
  store: Store;
  thread: ThreadRow;
  workspaceRoot: string;
  paths: Record<string, string>;
}

interface Scenario {
  id: string;
  title: string;
  hardStepCap?: number;
  context?: Partial<typeof config.agent>;
  prepare(ctx: VerifyContext): Promise<void>;
  input(ctx: VerifyContext): string;
  assert(ctx: VerifyContext, result: ScenarioRunResult): Promise<AssertionResult[]>;
}

interface RawMessage {
  role: LlmMessage['role'];
  content: string | null;
  tool_calls: LlmMessage['toolCalls'] | null;
  tool_call_id: string | null;
  collapsed: 'masked' | 'summarized' | null;
}

interface ScenarioRunResult {
  runId: string;
  status: string;
  error: string | null;
  output: string | null;
  events: AgentEvent[];
  rawMessages: RawMessage[];
}

interface AssertionResult {
  name: string;
  ok: boolean;
  detail?: string;
}

interface ScenarioReport {
  id: string;
  title: string;
  threadId: string;
  runId?: string;
  status: 'pass' | 'fail';
  assertions: AssertionResult[];
  steps: number;
  toolCalls: string[];
  finalOutput?: string | null;
  error?: string | null;
}

function ok(name: string, detail?: string): AssertionResult {
  return { name, ok: true, detail };
}

function fail(name: string, detail?: string): AssertionResult {
  return { name, ok: false, detail };
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

function hasTool(events: AgentEvent[], name: string): boolean {
  return events.some((event) => event.type === 'tool_call' && event.name === name);
}

function toolNames(events: AgentEvent[]): string[] {
  return events.filter((event): event is Extract<AgentEvent, { type: 'tool_call' }> => event.type === 'tool_call').map((event) => event.name);
}

function stepCount(events: AgentEvent[]): number {
  return new Set(events.filter((event) => 'step' in event).map((event) => event.step)).size;
}

function assertRunDone(result: ScenarioRunResult): AssertionResult {
  return result.status === 'done' ? ok('run 状态为 done') : fail('run 状态为 done', `实际状态：${result.status}；错误：${result.error ?? '无'}`);
}

function assertNoBrokenToolPairs(messages: RawMessage[]): AssertionResult {
  const answered = new Set<string>();
  const requested = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) requested.add(call.id);
    }
    if (message.role === 'tool' && message.tool_call_id) answered.add(message.tool_call_id);
  }
  const missingResults = [...requested].filter((id) => !answered.has(id));
  const orphanResults = [...answered].filter((id) => !requested.has(id));
  if (!missingResults.length && !orphanResults.length) return ok('tool_call 和 tool_result 配对完整');
  return fail('tool_call 和 tool_result 配对完整', `缺 result：${missingResults.join(',') || '无'}；孤儿 result：${orphanResults.join(',') || '无'}`);
}

function assertFinalAssistantHasNoToolCall(messages: RawMessage[]): AssertionResult {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants.at(-1);
  if (!last) return fail('最终 assistant 消息存在', '没有 assistant 消息');
  if (last.tool_calls?.length) return fail('最终 assistant 是无工具正文', `最终 assistant 仍有 ${last.tool_calls.length} 个 tool_call`);
  return last.content?.trim() ? ok('最终 assistant 是无工具正文') : fail('最终 assistant 是无工具正文', '最终 assistant content 为空');
}

async function rawMessagesForThread(threadId: string): Promise<RawMessage[]> {
  const { rows } = await query<RawMessage>(
    `SELECT role, content, tool_calls, tool_call_id, collapsed
     FROM messages
     WHERE thread_id = $1
     ORDER BY id`,
    [threadId],
  );
  return rows;
}

async function loadRunResult(store: Store, threadId: string, runId: string): Promise<ScenarioRunResult> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run 不存在：${runId}`);
  return {
    runId,
    status: run.status,
    error: run.error,
    output: run.output,
    events: await store.getEvents(runId),
    rawMessages: await rawMessagesForThread(threadId),
  };
}

function verificationToolSettings(base: ToolSettings, workspaceRoot: string): ToolSettings {
  return {
    ...base,
    sandbox: 'enforce',
    sandboxBackend: 'none',
    workspaceRoot,
    toolAccessMode: 'allow',
    allow: TOOL_ALLOW,
    deny: [],
    shellEnabled: true,
    shellUseHostPath: true,
    network: 'disabled',
    maxOutput: Math.min(base.maxOutput, 40_000),
  };
}

async function createPriorCompactionHistory(ctx: VerifyContext): Promise<void> {
  const prior = await ctx.store.createRun(ctx.thread.id, '最早用户消息：锚点短语是 RFG-COMPACTION-ANCHOR。请在后续任务中保留它。');
  await ctx.store.addMessage(ctx.thread.id, prior.id, null, {
    role: 'user',
    content: '最早用户消息：锚点短语是 RFG-COMPACTION-ANCHOR。请在后续任务中保留它。',
  });
  await ctx.store.addMessage(ctx.thread.id, prior.id, null, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'verify_big_tool_1', name: 'file_read', arguments: JSON.stringify({ path: ctx.paths.big }) }],
  });
  await ctx.store.addMessage(ctx.thread.id, prior.id, null, {
    role: 'tool',
    content: `历史大工具输出\n${'x'.repeat(18_000)}`,
    toolCallId: 'verify_big_tool_1',
  });
  await ctx.store.setRunStatus(prior.id, 'done', { output: '预置历史完成。' });
}

const scenarios: Scenario[] = [
  {
    id: 'basic-tool-composition',
    title: '文件工具组合：读取输入并写出结果',
    hardStepCap: 12,
    async prepare(ctx) {
      ctx.paths.input = resolve(ctx.workspaceRoot, 'basic/input.txt');
      ctx.paths.output = resolve(ctx.workspaceRoot, 'basic/output.txt');
      await writeText(ctx.paths.input, 'source=alpha\nstatus=pending\n');
    },
    input(ctx) {
      return [
        '请完成 RunForge agent 核心验收场景 basic-tool-composition。',
        `必须先读取文件：${ctx.paths.input}`,
        `然后创建文件：${ctx.paths.output}`,
        '输出文件必须包含两行：source=alpha 和 status=verified。',
        '请调用 update_plan 维护计划。完成后用无工具调用的最终正文简短说明结果；不要询问用户。',
      ].join('\n');
    },
    async assert(ctx, result) {
      const assertions = [assertRunDone(result), assertNoBrokenToolPairs(result.rawMessages), assertFinalAssistantHasNoToolCall(result.rawMessages)];
      const output = existsSync(ctx.paths.output) ? await readText(ctx.paths.output) : '';
      assertions.push(output.includes('source=alpha') && output.includes('status=verified')
        ? ok('文件输出内容正确')
        : fail('文件输出内容正确', `实际内容：${output || '文件不存在或为空'}`));
      assertions.push(hasTool(result.events, 'file_read') ? ok('调用过 file_read') : fail('调用过 file_read'));
      assertions.push(hasTool(result.events, 'file_write') ? ok('调用过 file_write') : fail('调用过 file_write'));
      return assertions;
    },
  },
  {
    id: 'plan-goal-finalization',
    title: '计划锚点：update_plan、goal_state 和最终收口',
    hardStepCap: 12,
    async prepare(ctx) {
      ctx.paths.done = resolve(ctx.workspaceRoot, 'plan/done.txt');
    },
    input(ctx) {
      return [
        '请完成 RunForge agent 核心验收场景 plan-goal-finalization。',
        '你必须先调用 update_plan 写出包含“写入验收文件”和“最终汇报”的计划。',
        `然后写入文件：${ctx.paths.done}`,
        '文件内容必须是：plan-ok',
        '最后输出无工具调用的最终正文；不要为了关闭计划再多跑一轮。',
      ].join('\n');
    },
    async assert(ctx, result) {
      const run = await ctx.store.getRun(result.runId);
      const content = existsSync(ctx.paths.done) ? (await readText(ctx.paths.done)).trim() : '';
      return [
        assertRunDone(result),
        assertNoBrokenToolPairs(result.rawMessages),
        assertFinalAssistantHasNoToolCall(result.rawMessages),
        result.events.some((event) => event.type === 'plan_update') ? ok('产生 plan_update 事件') : fail('产生 plan_update 事件'),
        run?.goal_state?.plan?.length ? ok('goal_state 已落库') : fail('goal_state 已落库'),
        content === 'plan-ok' ? ok('计划场景文件内容正确') : fail('计划场景文件内容正确', `实际内容：${content || '文件不存在或为空'}`),
      ];
    },
  },
  {
    id: 'shell-plus-file-workflow',
    title: 'Shell + 文件工具：运行命令并写报告',
    hardStepCap: 14,
    async prepare(ctx) {
      ctx.paths.numbers = resolve(ctx.workspaceRoot, 'shell/numbers.txt');
      ctx.paths.report = resolve(ctx.workspaceRoot, 'shell/report.txt');
      await writeText(ctx.paths.numbers, 'one\ntwo\nthree\n');
    },
    input(ctx) {
      return [
        '请完成 RunForge agent 核心验收场景 shell-plus-file-workflow。',
        `必须使用 shell 执行：wc -l ${ctx.paths.numbers}`,
        `然后必须调用 file_write 工具把行数写入文件：${ctx.paths.report}`,
        '不要用 shell 重定向、tee、printf、cat > file 之类命令写报告文件；shell 只用于统计行数。',
        '报告文件内容必须包含：lines=3',
        '完成后输出最终正文；不要询问用户。',
      ].join('\n');
    },
    async assert(ctx, result) {
      const report = existsSync(ctx.paths.report) ? await readText(ctx.paths.report) : '';
      return [
        assertRunDone(result),
        assertNoBrokenToolPairs(result.rawMessages),
        assertFinalAssistantHasNoToolCall(result.rawMessages),
        hasTool(result.events, 'shell') ? ok('调用过 shell') : fail('调用过 shell'),
        hasTool(result.events, 'file_write') ? ok('调用过 file_write') : fail('调用过 file_write'),
        report.includes('lines=3') ? ok('shell 报告内容正确') : fail('shell 报告内容正确', `实际内容：${report || '文件不存在或为空'}`),
      ];
    },
  },
  {
    id: 'context-compaction-survival',
    title: '上下文压缩：大历史裁剪后仍完成当前目标',
    hardStepCap: 14,
    context: { contextBudget: 2_000, compactWarnRatio: 0.2, compactHardRatio: 10, keepRecentMessages: 2 },
    async prepare(ctx) {
      ctx.paths.big = resolve(ctx.workspaceRoot, 'compaction/big.txt');
      ctx.paths.target = resolve(ctx.workspaceRoot, 'compaction/target.txt');
      ctx.paths.result = resolve(ctx.workspaceRoot, 'compaction/result.txt');
      await writeText(ctx.paths.big, 'big-history-source\n');
      await writeText(ctx.paths.target, 'target=ok\n');
      await createPriorCompactionHistory(ctx);
    },
    input(ctx) {
      return [
        '请完成 RunForge agent 核心验收场景 context-compaction-survival。',
        '最早用户消息里有一个锚点短语。请从历史上下文中读取这个锚点短语，不要向用户询问。',
        `请读取当前目标文件：${ctx.paths.target}`,
        `然后写入结果文件：${ctx.paths.result}`,
        '结果文件必须包含两段信息：anchor=<最早用户消息里的锚点短语> 和 target=ok。',
        '完成后输出最终正文。',
      ].join('\n');
    },
    async assert(ctx, result) {
      const content = existsSync(ctx.paths.result) ? await readText(ctx.paths.result) : '';
      const collapsed = result.rawMessages.filter((message) => message.collapsed === 'masked' || message.collapsed === 'summarized');
      return [
        assertRunDone(result),
        assertNoBrokenToolPairs(result.rawMessages),
        assertFinalAssistantHasNoToolCall(result.rawMessages),
        result.events.some((event) => event.type === 'compaction') ? ok('产生 compaction 事件') : fail('产生 compaction 事件'),
        collapsed.length ? ok('messages.collapsed 有记录', `collapsed=${collapsed.length}`) : fail('messages.collapsed 有记录'),
        content.includes('RFG-COMPACTION-ANCHOR') && content.includes('target=ok')
          ? ok('压缩后仍保留锚点并完成目标')
          : fail('压缩后仍保留锚点并完成目标', `实际内容：${content || '文件不存在或为空'}`),
      ];
    },
  },
  {
    id: 'coding-fixture-repair',
    title: '代码修复：真实修改 fixture 并通过测试',
    hardStepCap: 18,
    async prepare(ctx) {
      ctx.paths.math = resolve(ctx.workspaceRoot, 'coding/math.mjs');
      ctx.paths.test = resolve(ctx.workspaceRoot, 'coding/test.mjs');
      await writeText(ctx.paths.math, 'export function add(a, b) {\n  return a - b;\n}\n');
      await writeText(ctx.paths.test, [
        "import assert from 'node:assert/strict';",
        "import { add } from './math.mjs';",
        'assert.equal(add(2, 3), 5);',
        "console.log('fixture-pass');",
        '',
      ].join('\n'));
    },
    input(ctx) {
      return [
        '请完成 RunForge agent 核心验收场景 coding-fixture-repair。',
        `修复文件：${ctx.paths.math}`,
        `验证命令必须使用 shell 执行：node ${ctx.paths.test}`,
        '目标是让验证命令输出 fixture-pass 并退出码为 0。',
        '请优先用 file_read/file_edit/shell 组合完成。完成后输出最终正文；不要询问用户。',
      ].join('\n');
    },
    async assert(ctx, result) {
      let verifyOutput = '';
      let verifyOk = false;
      try {
        const out = await execFileAsync(process.execPath, [ctx.paths.test], { cwd: dirname(ctx.paths.test), timeout: 10_000 });
        verifyOutput = `${out.stdout}${out.stderr}`.trim();
        verifyOk = true;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        verifyOutput = `${e.message ?? ''}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
      }
      return [
        assertRunDone(result),
        assertNoBrokenToolPairs(result.rawMessages),
        assertFinalAssistantHasNoToolCall(result.rawMessages),
        hasTool(result.events, 'shell') ? ok('调用过 shell 验证') : fail('调用过 shell 验证'),
        verifyOk && verifyOutput.includes('fixture-pass') ? ok('fixture 测试真实通过') : fail('fixture 测试真实通过', verifyOutput),
      ];
    },
  },
];

function applyContextOverride(override: Partial<typeof config.agent> | undefined): () => void {
  const original = { ...config.agent };
  if (override) Object.assign(config.agent, override);
  return () => Object.assign(config.agent, original);
}

async function runScenario(store: Store, baseToolSettings: ToolSettings, root: string, scenario: Scenario): Promise<ScenarioReport> {
  const workspaceRoot = resolve(root, scenario.id);
  await mkdir(workspaceRoot, { recursive: true });
  const thread = await store.createThread(`[verify] ${scenario.id}`);
  const ctx: VerifyContext = { store, thread, workspaceRoot, paths: {} };
  const restoreContext = applyContextOverride(scenario.context);
  try {
    await scenario.prepare(ctx);
    const run = await store.createRun(thread.id, scenario.input(ctx));
    await executeRun(run.id, {
      store,
      hardStepCap: scenario.hardStepCap ?? 16,
      stream: false,
      generateThreadTitle: false,
      toolSettings: verificationToolSettings(baseToolSettings, workspaceRoot),
      mcpSettings: { servers: [] },
      databaseRuntimeEnv: async () => ({
        env: {},
        summary: 'Agent core verification: database runtime is intentionally disabled for this scenario.\nAgent 核心验收：本场景故意不注入数据库运行凭证。',
      }),
      publish: () => {},
    });
    const result = await loadRunResult(store, thread.id, run.id);
    const assertions = await scenario.assert(ctx, result);
    return {
      id: scenario.id,
      title: scenario.title,
      threadId: thread.id,
      runId: run.id,
      status: assertions.every((item) => item.ok) ? 'pass' : 'fail',
      assertions,
      steps: stepCount(result.events),
      toolCalls: toolNames(result.events),
      finalOutput: result.output,
      error: result.error,
    };
  } catch (err) {
    return {
      id: scenario.id,
      title: scenario.title,
      threadId: thread.id,
      status: 'fail',
      assertions: [fail('场景执行未抛异常', (err as Error).stack ?? (err as Error).message)],
      steps: 0,
      toolCalls: [],
      error: (err as Error).message,
    };
  } finally {
    restoreContext();
  }
}

function markdownReport(startedAt: string, reports: ScenarioReport[]): string {
  const passed = reports.filter((report) => report.status === 'pass').length;
  const lines = [
    '# Agent Core Verification Report',
    '',
    `startedAt: ${startedAt}`,
    `status: ${passed}/${reports.length} passed`,
    '',
  ];
  for (const report of reports) {
    lines.push(`## ${report.status === 'pass' ? 'PASS' : 'FAIL'} ${report.id}`);
    lines.push('');
    lines.push(`title: ${report.title}`);
    lines.push(`threadId: ${report.threadId}`);
    if (report.runId) lines.push(`runId: ${report.runId}`);
    lines.push(`steps: ${report.steps}`);
    lines.push(`toolCalls: ${report.toolCalls.join(', ') || 'none'}`);
    if (report.error) lines.push(`error: ${report.error}`);
    lines.push('');
    for (const assertion of report.assertions) {
      lines.push(`- ${assertion.ok ? 'PASS' : 'FAIL'} ${assertion.name}${assertion.detail ? `：${assertion.detail}` : ''}`);
    }
    if (report.finalOutput) {
      lines.push('', 'finalOutput:', '```', report.finalOutput.slice(0, 2000), '```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const selected = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('--')));
  const targets = selected.size ? scenarios.filter((scenario) => selected.has(scenario.id)) : scenarios;
  if (!targets.length) {
    throw new Error(`没有匹配的验收场景。可选：${scenarios.map((scenario) => scenario.id).join(', ')}`);
  }

  const startedAt = new Date().toISOString();
  const runRoot = resolve(VERIFY_ROOT, startedAt.replace(/[:.]/g, '-'));
  await mkdir(runRoot, { recursive: true });

  const store = new PgStore();
  const baseToolSettings = await getToolSettings();
  const reports: ScenarioReport[] = [];
  for (const scenario of targets) {
    console.log(`▶ ${scenario.id}`);
    const report = await runScenario(store, baseToolSettings, runRoot, scenario);
    reports.push(report);
    console.log(`${report.status === 'pass' ? '✓' : '✗'} ${scenario.id}`);
  }

  const payload = { startedAt, finishedAt: new Date().toISOString(), reportRoot: runRoot, reports };
  await writeText(resolve(runRoot, 'report.json'), JSON.stringify(payload, null, 2));
  await writeText(resolve(runRoot, 'report.md'), markdownReport(startedAt, reports));

  const passed = reports.filter((report) => report.status === 'pass').length;
  console.log(`\nAgent core verification: ${passed}/${reports.length} passed`);
  console.log(`Report: ${resolve(runRoot, 'report.md')}`);
  if (passed !== reports.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`Agent core verification failed: ${(err as Error).stack ?? (err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
