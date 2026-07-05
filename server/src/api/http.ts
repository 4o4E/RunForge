import { Router } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { executeRun } from '../agent/executor.js';
import { store } from '../store/index.js';
import { filesApi } from './files.js';
import { settingsApi } from './settings.js';
import { datasourcesApi } from './datasources.js';
import { runtimeApi } from './runtime.js';
import { notificationsApi } from './notifications.js';
import { requireApiAccess } from './auth.js';
import { releaseRunLeases } from '../datasources/accountPool.js';
import type { AskUserAnswer, AskUserOption, AskUserSpec } from '../agent/types.js';
import { shellManager } from '../shell/manager.js';
import { shellBus } from '../shell/bus.js';
import { getLlmSettings, getToolSettings, llmModelOptions } from '../settings.js';
import { createPolicy } from '../tools/policy.js';
import { isWithin } from '../tools/policy.js';

export const api = Router();

api.use(requireApiAccess);
api.use('/files', filesApi);
api.use('/settings', settingsApi);
api.use('/datasources', datasourcesApi);
api.use('/runtime', runtimeApi);
api.use('/notifications', notificationsApi);

async function killRunShellCommands(runId: string): Promise<void> {
  try {
    await shellManager.killRunCommands(runId, 'run_cancel');
  } catch (err) {
    const message = (err as Error).message;
    if (!message.includes('relation "shell_commands" does not exist')) {
      console.warn(`shell command cleanup during cancel failed: ${message}`);
    }
  }
}

function normalizeShellSignal(value: unknown, fallback: NodeJS.Signals): NodeJS.Signals {
  return value === 'SIGINT' || value === 'SIGTERM' || value === 'SIGKILL' ? value : fallback;
}

function commandDurationMs(command: Awaited<ReturnType<typeof store.getShellCommand>>): number | null {
  if (!command?.ended_at) return null;
  return Math.max(0, new Date(command.ended_at).getTime() - new Date(command.started_at).getTime());
}

function renderShellLogs(logs: Awaited<ReturnType<typeof store.getShellCommandLogs>>): string {
  let current = '';
  const chunks: string[] = [];
  for (const log of logs) {
    if (log.stream !== current) {
      current = log.stream;
      chunks.push(`\n[${current}]\n`);
    }
    chunks.push(log.chunk);
  }
  return chunks.join('').trim();
}

async function readAllShellCommandLogs(commandId: string): Promise<Awaited<ReturnType<typeof store.getShellCommandLogs>>> {
  const logs: Awaited<ReturnType<typeof store.getShellCommandLogs>> = [];
  let sinceSeq = 0;
  for (;;) {
    const page = await store.getShellCommandLogs(commandId, sinceSeq, 1000);
    if (!page.length) return logs;
    logs.push(...page);
    sinceSeq = page[page.length - 1].seq;
    if (page.length < 1000) return logs;
  }
}

function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n...[已截断 ${text.length - maxChars} 个字符，完整内容见附件文件]...\n`;
  const body = Math.max(0, maxChars - marker.length);
  const head = Math.floor(body * 0.6);
  const tail = body - head;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

async function validateRunModelRef(modelRef: string | null): Promise<string | null> {
  if (!modelRef) return null;
  const settings = await getLlmSettings();
  const options = llmModelOptions(settings);
  if (!options.some((option) => option.ref === modelRef)) {
    throw new Error(`模型未启用：${modelRef}`);
  }
  return modelRef;
}

// --- Threads ---

api.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50));
  res.json({ query: q, results: await store.searchThreadMessages(q, limit) });
});

// 创建 thread。
api.post('/threads', async (req, res) => {
  const title = req.body?.title ? String(req.body.title) : undefined;
  const thread = await store.createThread(title);
  res.status(201).json(thread);
});

// 列出 thread。默认只返回未归档列表；设置页通过 archived=1 查看归档列表。
api.get('/threads', async (req, res) => {
  const archived = req.query.archived === '1' || req.query.archived === 'true';
  res.json(await store.listThreads(50, { archived }));
});

// thread 详情：包含 run 和事件，用于恢复对话。
api.get('/threads/:id', async (req, res) => {
  const thread = await store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  const runs = await store.listRuns(thread.id);
  const withEvents = await Promise.all(
    runs.map(async (run) => ({ ...run, events: await store.getEvents(run.id) })),
  );
  res.json({ thread, runs: withEvents, notices: await store.listThreadNotices(thread.id) });
});

// 更新 thread 元信息：重命名、置顶/取消置顶、归档/取消归档。
api.patch('/threads/:id', async (req, res) => {
  const fields: { title?: string | null; pinned?: boolean; archived?: boolean; activeRunId?: string | null } = {};
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'title')) {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    fields.title = title || null;
  }
  const pinned = optionalBoolean(req.body?.pinned);
  if (pinned !== undefined) fields.pinned = pinned;
  const archived = optionalBoolean(req.body?.archived);
  if (archived !== undefined) fields.archived = archived;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'activeRunId')) {
    fields.activeRunId = optionalText(req.body.activeRunId);
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: '缺少可更新字段' });
  const thread = await store.updateThread(req.params.id, fields);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  res.json(thread);
});

// thread 下的 subagent 子任务列表。右侧资源栏用它恢复和打开历史 subagent。
api.get('/threads/:id/subagents', async (req, res) => {
  const thread = await store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  res.json({ subagents: await store.listSubagentRunsByThread(thread.id) });
});

// 删除 thread 及关联 run 数据，级联删除由 PostgreSQL 负责。
api.delete('/threads/:id', async (req, res) => {
  const deleted = await store.deleteThread(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'thread 不存在' });
  res.status(204).send();
});

// 在 thread 内启动一次 run。
api.post('/threads/:id/runs', async (req, res) => {
  const thread = await store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  const input = String(req.body?.input ?? '').trim();
  if (!input) return res.status(400).json({ error: 'input 为必填' });
  let modelRef: string | null = null;
  try {
    modelRef = await validateRunModelRef(optionalText(req.body?.modelRef));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  let run;
  try {
    run = await store.createRun(thread.id, input, { modelRef, parentRunId: optionalText(req.body?.parentRunId) ?? undefined });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  // 后台执行：agent 循环在当前进程内运行，并通过 WebSocket 推送事件。
  void executeRun(run.id);
  res.status(201).json({ id: run.id, threadId: thread.id, status: run.status });
});

// --- Runs ---

// run 详情：包含事件，前端按 step 分组展示。
api.get('/runs/:id', async (req, res) => {
  const run = await store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  const events = await store.getEvents(run.id);
  res.json({ run, events });
});

// 从某条历史 run 的父节点创建新分支。旧 run 和其后续分支都保留，但不会进入新 run 上下文。
api.post('/runs/:id/branch', async (req, res) => {
  const source = await store.getRun(req.params.id);
  if (!source) return res.status(404).json({ error: 'run 不存在' });
  const thread = await store.getThread(source.thread_id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  if (thread.active_run_id !== source.id) {
    return res.status(409).json({ error: '只能修改当前分支最后一条用户消息' });
  }
  if (source.status === 'pending' || source.status === 'running' || source.status === 'canceling') {
    return res.status(409).json({ error: `run 当前状态为 ${source.status}，暂不能分支重跑` });
  }
  const input = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'input')
    ? String(req.body?.input ?? '').trim()
    : source.input;
  if (!input) return res.status(400).json({ error: 'input 为必填' });
  let modelRef: string | null = source.model_ref;
  try {
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'modelRef')) {
      modelRef = await validateRunModelRef(optionalText(req.body?.modelRef));
    }
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const run = await store.createRun(source.thread_id, input, { modelRef, parentRunId: source.parent_run_id });
  void executeRun(run.id);
  res.status(201).json({ id: run.id, threadId: source.thread_id, status: run.status });
});

// 从指定用户消息 fork 出新对话：复制当前分支从开头到该用户消息，关联提示只用于 UI 展示。
api.post('/runs/:id/fork', async (req, res) => {
  const fork = await store.forkThreadAtRun(req.params.id);
  if (!fork) return res.status(404).json({ error: 'run 不存在' });
  res.status(201).json({
    thread: fork.thread,
    activeRun: { ...fork.activeRun, events: await store.getEvents(fork.activeRun.id) },
  });
});

// 取消 run。运行中的 run 走协作式取消；等待用户回答时 executor 已暂停，
// 需要直接落成 canceled，避免刷新后继续卡在 ask_user。
api.post('/runs/:id/cancel', async (req, res) => {
  const run = await store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  if (run.status === 'waiting_for_user') {
    const step = (await store.getLastStepIndex(run.id)) + 1;
    await killRunShellCommands(run.id);
    await store.addEvent(run.id, null, { type: 'user_cancel', step, reason: '用户已取消 run。' });
    await store.setRunStatus(run.id, 'canceled', { error: '用户已取消 run。' });
    await releaseRunLeases(run.id);
    return res.json({ id: run.id, status: 'canceled' });
  }
  if (run.status === 'pending' || run.status === 'running') {
    await killRunShellCommands(run.id);
    await store.setRunStatus(run.id, 'canceling');
    return res.json({ id: run.id, status: 'canceling' });
  }
  res.json({ id: run.id, status: run.status });
});

// 回答暂停中的 run，并恢复同一个 run。空回答表示“按默认假设继续”。
api.post('/runs/:id/answer', async (req, res) => {
  const run = await store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  if (run.status !== 'waiting_for_user') return res.status(409).json({ error: `run 当前状态为 ${run.status}，不是 waiting_for_user` });

  const spec = latestAskUserSpec(await store.getEvents(run.id));
  const answer = normalizeAnswer(req.body?.answer, spec);
  const invalid = validateAnswer(answer, spec);
  if (invalid) return res.status(400).json({ error: invalid });
  await store.addMessage(run.thread_id, run.id, null, {
    role: 'user',
    content: `用户回答：\n${formatAnswerForModel(answer)}`,
  });
  await store.addEvent(run.id, null, { type: 'user_answer', step: (await store.getLastStepIndex(run.id)) + 1, answer });
  await store.setRunStatus(run.id, 'pending');
  void executeRun(run.id, { resume: true });
  res.json({ id: run.id, threadId: run.thread_id, status: 'running' });
});

// --- Managed shell ---

api.get('/shell-sessions', async (req, res) => {
  const threadId = String(req.query.threadId ?? '').trim();
  if (!threadId) return res.status(400).json({ error: 'threadId 为必填' });
  const thread = await store.getThread(threadId);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  const settings = await getToolSettings();
  const sessions = await shellManager.listSessions(threadId, settings);
  const result = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      commands: await store.listShellCommandsBySession(session.id, 50),
    })),
  );
  res.json({ sessions: result });
});

api.post('/shell-sessions', async (req, res) => {
  const threadId = String(req.body?.threadId ?? '').trim();
  if (!threadId) return res.status(400).json({ error: 'threadId 为必填' });
  const thread = await store.getThread(threadId);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  const settings = await getToolSettings();
  const decision = createPolicy(settings).check('shell_session_open', { command: '' });
  if (!decision.ok) return res.status(403).json({ error: decision.reason });
  const session = await shellManager.openSession({
    threadId,
    settings,
    owner: 'user',
    name: typeof req.body?.name === 'string' ? req.body.name : undefined,
  });
  res.status(201).json({ session });
});

api.patch('/shell-sessions/:id', async (req, res) => {
  const session = await store.getShellSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  if (session.deleted_at) return res.status(404).json({ error: 'shell session 已删除' });
  if (session.name === 'Default' || session.owner === 'system') return res.status(403).json({ error: 'Default shell 不支持改名' });
  if (session.owner !== 'user') return res.status(403).json({ error: '用户不能改名 agent 创建的 shell' });
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name 为必填' });
  if (name === 'Default') return res.status(400).json({ error: 'Default 是系统保留名称' });
  const siblings = await store.listShellSessions(session.thread_id, session.workspace_root);
  if (siblings.some((item) => item.id !== session.id && item.name === name)) {
    return res.status(409).json({ error: `shell 名称已存在：${name}` });
  }
  await store.updateShellSession(session.id, { name });
  await store.addShellSessionEvent(session.id, 'user', 'renamed', { name });
  res.json({ session: await store.getShellSession(session.id) });
});

api.get('/shell-sessions/:id/commands', async (req, res) => {
  const session = await store.getShellSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  res.json({ session, commands: await store.listShellCommandsBySession(session.id, limit) });
});

api.post('/shell-sessions/:id/close', async (req, res) => {
  const session = await store.getShellSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  if (session.name === 'Default' || session.owner === 'system') return res.status(403).json({ error: 'Default shell 不支持删除' });
  if (session.owner !== 'user') return res.status(403).json({ error: '用户不能删除 agent 创建的 shell' });
  const commands = await store.listShellCommandsBySession(session.id, 50);
  const running = commands.filter((cmd) => cmd.status === 'queued' || cmd.status === 'running');
  if (running.length && req.body?.force !== true) {
    return res.status(409).json({ error: `shell session 仍有运行中命令：${running.map((cmd) => cmd.id).join(', ')}` });
  }
  for (const command of running) {
    await shellManager.kill(command.id, 'session_close', 'SIGTERM');
  }
  await store.updateShellSession(session.id, { status: 'closed', lease_actor: null, lease_run_id: null, deleted_at: new Date().toISOString() });
  await store.addShellSessionEvent(session.id, 'user', 'deleted', { force: req.body?.force === true });
  shellBus.publish(session.thread_id, { type: 'shell_session_closed', step: 0, sessionId: session.id, reason: '用户关闭 session。' });
  res.json({ session: await store.getShellSession(session.id) });
});

api.post('/shell-sessions/:id/commands', async (req, res) => {
  const session = await store.getShellSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  const command = String(req.body?.command ?? '').trim();
  if (!command) return res.status(400).json({ error: 'command 为必填' });
  const settings = await getToolSettings();
  const policy = createPolicy(settings);
  const decision = policy.check('shell_exec', { command });
  if (!decision.ok) return res.status(403).json({ error: decision.reason });
  const result = await shellManager.exec({
    sessionId: session.id,
    command,
    settings,
    context: { threadId: session.thread_id },
    waitMode: req.body?.wait === 'foreground' ? 'foreground' : 'background',
    waitTimeoutMs: Number(req.body?.timeout_ms ?? 1000),
    softTimeoutMs: typeof req.body?.soft_timeout_ms === 'number' ? req.body.soft_timeout_ms : null,
    hardTimeoutMs: typeof req.body?.hard_timeout_ms === 'number' ? req.body.hard_timeout_ms : null,
    actor: 'user',
  });
  res.status(201).json({ command: result.command, timedOutWaiting: result.timedOutWaiting, tail: result.tail });
});

api.get('/shell-commands/:id/logs', async (req, res) => {
  const command = await store.getShellCommand(req.params.id);
  if (!command) return res.status(404).json({ error: 'shell command 不存在' });
  const sinceSeq = Math.max(0, Number(req.query.sinceSeq ?? 0));
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
  res.json({ command, logs: await store.getShellCommandLogs(command.id, sinceSeq, limit) });
});

api.post('/shell-commands/:id/mark', async (req, res) => {
  const command = await store.getShellCommand(req.params.id);
  if (!command) return res.status(404).json({ error: 'shell command 不存在' });
  if (command.status === 'queued' || command.status === 'running') {
    return res.status(409).json({ error: 'shell command 仍在运行，结束后才能标记' });
  }
  const session = await store.getShellSession(command.session_id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  const settings = await getToolSettings();
  if (!isWithin(settings.workspaceRoot, session.workspace_root)) {
    return res.status(403).json({ error: 'shell session 不属于当前 workspace' });
  }

  const logs = await readAllShellCommandLogs(command.id);
  const output = renderShellLogs(logs);
  const maxInline = settings.maxOutput;
  let outputPath: string | null = null;
  if (output.length > maxInline) {
    outputPath = `.tmp/shell-marks/${command.id}.txt`;
    const absolute = resolve(settings.workspaceRoot, outputPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, output, 'utf8');
  }
  const duration = commandDurationMs(command);
  const markedText = [
    `用户从 shell "${session.name}" 标记了一次交互，供 LLM 作为上下文参考。`,
    '',
    `Shell 名称/ID: ${session.name} (${session.id})`,
    `命令 ID / Command ID: ${command.id}`,
    `执行者 / Actor: ${command.actor}`,
    `CWD: ${command.cwd}`,
    `命令 / Command: ${command.command}`,
    `状态 / Status: ${command.status}`,
    command.exit_code != null ? `退出码 / Exit code: ${command.exit_code}` : '',
    command.signal ? `信号 / Signal: ${command.signal}` : '',
    duration != null ? `耗时毫秒 / Duration ms: ${duration}` : '',
    outputPath ? `完整输出文件 / Full output file: ${outputPath}` : '',
    '',
    '输出 / Output:',
    output ? headTail(output, maxInline) : '（无输出）',
  ].filter(Boolean).join('\n');

  res.json({
    attachment: {
      kind: 'shell',
      commandId: command.id,
      shellName: session.name,
      name: `${session.name}: ${command.command.slice(0, 40)}`,
      text: markedText,
      size: output.length,
      path: outputPath,
    },
  });
});

api.post('/shell-commands/:id/kill', async (req, res) => {
  const signal = normalizeShellSignal(req.body?.signal, 'SIGTERM');
  const command = await shellManager.kill(req.params.id, String(req.body?.reason ?? 'user_requested_kill'), signal);
  res.json({ command });
});

function latestAskUserSpec(events: Awaited<ReturnType<typeof store.getEvents>>): AskUserSpec | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'user_question' && event.spec) return event.spec;
  }
  return null;
}

function normalizeAnswer(value: unknown, spec: AskUserSpec | null = null): AskUserAnswer {
  if (!value || typeof value !== 'object') {
    const text = String(value ?? '').trim();
    return {
      mode: spec?.mode ?? 'text',
      selected: [],
      customOptions: [],
      text,
      note: text || '按默认假设继续。',
      usedRecommended: !text,
    };
  }
  const raw = value as Record<string, unknown>;
  const selected = Array.isArray(raw.selected)
    ? raw.selected
        .map((item) => (item && typeof item === 'object' ? item as Record<string, unknown> : null))
        .filter((item): item is Record<string, unknown> => !!item)
        .map((item) => ({
          id: String(item.id ?? item.label ?? '').trim(),
          label: String(item.label ?? item.id ?? '').trim(),
          description: typeof item.description === 'string' ? item.description : undefined,
          recommended: item.recommended === true,
          required: item.required === true,
        }))
        .filter((item) => item.label)
    : [];
  return {
    mode: spec?.mode ?? (raw.mode === 'single' || raw.mode === 'multiple' || raw.mode === 'text' ? raw.mode : 'text'),
    selected,
    customOptions: Array.isArray(raw.customOptions) ? raw.customOptions.map((x) => String(x).trim()).filter(Boolean) : [],
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
    note: typeof raw.note === 'string' ? raw.note.trim() : '',
    usedRecommended: raw.usedRecommended === true,
  };
}

function validateAnswer(answer: AskUserAnswer, spec: AskUserSpec | null): string | null {
  if (!spec) return null;
  if (answer.mode !== spec.mode) return '回答类型与 ask_user 表单不匹配';
  if (spec.mode === 'text') {
    if (spec.required && !answer.text.trim()) return '文本回答为必填';
    return null;
  }

  if (spec.mode === 'single' && answer.selected.length > 1) {
    return '单选 ask_user 只能选择一个选项';
  }

  const optionById = new Map(spec.options.map((option) => [option.id, option]));
  const selectedIds = new Set(answer.selected.map((option) => option.id));
  const missingRequired = spec.options.filter((option) => option.required && !selectedIds.has(option.id));
  if (missingRequired.length) {
    return `缺少必选项：${missingRequired.map((option) => option.label).join(', ')}`;
  }
  if (spec.required && answer.selected.length === 0) {
    return '至少需要选择一个选项';
  }

  const customLabels = new Set(answer.customOptions);
  const unknown = answer.selected.filter((option) => !optionById.has(option.id) && !isAllowedCustomOption(option, customLabels, spec.allowCustom));
  if (unknown.length) {
    return `不允许未知选项：${unknown.map((option) => option.label).join(', ')}`;
  }
  return null;
}

function isAllowedCustomOption(option: AskUserOption, customLabels: Set<string>, allowCustom: boolean): boolean {
  return allowCustom && option.id.startsWith('custom:') && customLabels.has(option.label);
}

function formatAnswerForModel(answer: AskUserAnswer): string {
  return JSON.stringify(answer, null, 2);
}
