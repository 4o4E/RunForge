import { Router } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { executeRun } from '../agent/executor.js';
import { store } from '../store/index.js';
import { filesApi } from './files.js';
import { settingsApi } from './settings.js';
import { datasourcesApi } from './datasources.js';
import { runtimeApi } from './runtime.js';
import { runtimeCapabilitiesApi } from './runtimeCapabilities.js';
import { notificationsApi } from './notifications.js';
import { requireApiAccess } from './auth.js';
import { authApi } from './authRoutes.js';
import { systemAuthApi } from './systemAuth.js';
import { tenantsApi } from './tenants.js';
import { systemApi } from './system.js';
import { sendSpaceError, tenantSpacesApi } from './spaces.js';
import { requireSystemScope, requireTenantScope } from '../auth/guards.js';
import { getIdentity, requireScope, type IdentityContext } from '../auth/context.js';
import {
  DeleteConflictError,
  type DeleteResourceResult,
  type Scope,
  type ShellSessionRow,
  type StepContextSnapshot,
} from '../store/types.js';
import { releaseRunLeases } from '../datasources/accountPool.js';
import type { AskUserAnswer, AskUserOption, AskUserSpec } from '../agent/types.js';
import { shellManager } from '../shell/manager.js';
import { shellBus } from '../shell/bus.js';
import { getSystemToolSettings, type ToolSettings } from '../settings.js';
import { createPolicy } from '../tools/policy.js';
import type { Response } from 'express';
import type { LlmProviderState } from '../llm/types.js';
import { RunActiveError } from '../store/types.js';
import { spaceAccess } from '../spaces/access.js';
import { SpaceConfigError } from '../spaces/config.js';
import { runAdmission } from '../spaces/runAdmission.js';
import { externalApi } from './external.js';
import { threadWorkspaceAccess, ThreadWorkspaceAccessError } from '../files/threadWorkspace.js';
import { removeThreadWorkspace } from '../files/workspaceRoot.js';
import { threadReadAccess, ThreadReadAccessError } from '../threads/readAccess.js';
import { deletionGate } from '../deletion/gate.js';
import { stopThreadsForDeletion } from '../deletion/runtime.js';
import { removeExternalArtifacts } from '../deletion/files.js';
import { abortRunExecution } from '../agent/executionControl.js';
import { usageApi } from './usage.js';

export const api = Router();

function scopeOrReject(res: Response): Scope | null {
  const scope = requireScope();
  if (!scope) {
    res.status(403).json({ error: '需要租户身份' });
    return null;
  }
  return scope;
}

function tenantIdentityOrReject(res: Response): Extract<IdentityContext, { scope: 'tenant' }> | null {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return null;
  }
  return identity;
}

async function checkThreadSpaceAccess(
  res: Response,
  identity: Extract<IdentityContext, { scope: 'tenant' }>,
  spaceId: string,
  writable: boolean,
): Promise<boolean> {
  try {
    if (writable) await spaceAccess.requireWritableWebSpace(identity, spaceId);
    else await spaceAccess.get(identity, spaceId);
    return true;
  } catch (error) {
    sendSpaceError(res, error);
    return false;
  }
}

function sendRunActiveConflict(res: Response, err: unknown): boolean {
  if (err instanceof DeleteConflictError) {
    res.status(409).json({ error: err.message, code: err.code });
    return true;
  }
  if (!(err instanceof RunActiveError)) return false;
  res.status(409).json({
    error: err.message,
    code: err.code,
    currentRunId: err.currentRunId,
    currentStatus: err.currentStatus,
  });
  return true;
}

function sendThreadReadError(res: Response, error: unknown): void {
  if (error instanceof ThreadReadAccessError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  sendSpaceError(res, error);
}

// 登录/刷新/登出不需要已建立的身份，必须挂在 requireApiAccess 之前
// (docs/multi-tenancy-design.md §4"请求校验路径")。
api.use('/auth', authApi);
api.use('/system/auth', systemAuthApi);
// 外部调用方只通过秘密 UUID 路径鉴权，不得进入 JWT/API Token 身份解析。
api.use('/external', externalApi);

api.use(requireApiAccess);

// /system、/files、/runtime 各自单独处理 scope,不吃下面这条"租户身份"总闸:
// /system 本身就要求 system 身份;/files 要兼容"免身份的签名分享链接"这个例外
// (见 files.ts 的 requireFileAccess);/runtime 是容器脚本用 workload token 调用的
// 内部接口,不是 JWT,也不该建立任何租户身份(见 auth.ts 的 isRuntimeRequest)。
// 三个都要挂在总闸之前,否则会被总闸挡在门外。
api.use('/system', requireSystemScope, systemApi);
api.use('/files', filesApi);
api.use('/runtime', runtimeApi);
api.use('/runtime-capabilities', runtimeCapabilitiesApi);

// 总闸:下面全部路由都是面向租户用户的接口，系统管理员 JWT 不能冒充租户用户调用
// (docs/multi-tenancy-design.md §4)。注意这只堵住了"系统管理员访问租户接口"这个越权，
// 不是"租户之间互相看到对方数据"——后者需要 threads/runs 等业务表加 tenant_id 过滤，
// 是下一阶段的事，这里没有一并解决。
api.use(requireTenantScope);

api.use('/tenants', tenantsApi);
api.use('/spaces', tenantSpacesApi);
api.use('/settings', settingsApi);
api.use('/datasources', datasourcesApi);
api.use('/notifications', notificationsApi);
api.use('/usage', usageApi);

async function killRunShellCommands(scope: Scope, runId: string): Promise<void> {
  try {
    await shellManager.killRunCommands(scope, runId, 'run_cancel');
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

async function readAllShellCommandLogs(scope: Scope, commandId: string): Promise<Awaited<ReturnType<typeof store.getShellCommandLogs>>> {
  const logs: Awaited<ReturnType<typeof store.getShellCommandLogs>> = [];
  let sinceSeq = 0;
  for (;;) {
    const page = await store.getShellCommandLogs(scope, commandId, sinceSeq, 1000);
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

// --- Threads ---

function encryptedReasoningStats(providerState: LlmProviderState | undefined): { count: number; chars: number } {
  const encrypted = (providerState?.reasoningParts ?? []).flatMap((part) =>
    Object.values(part.providerOptions ?? {}).flatMap((options) => {
      const value = options.reasoningEncryptedContent ?? options.encrypted_content;
      return typeof value === 'string' ? [value] : [];
    }),
  );
  return { count: encrypted.length, chars: encrypted.reduce((sum, value) => sum + value.length, 0) };
}

function stepContextMessageView(message: StepContextSnapshot['messages'][number]) {
  const encrypted = encryptedReasoningStats(message.providerState);
  return {
    role: message.role,
    content: message.content,
    contentParts: message.contentParts?.map((part) => part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : {
          type: 'image' as const,
          mimeType: part.mimeType,
          path: part.path,
          name: part.name,
        }),
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    collapsed: message.collapsed,
    providerState: encrypted.count || message.providerState?.reasoningParts?.length
      ? {
          reasoningParts: message.providerState?.reasoningParts?.length ?? 0,
          encryptedChars: encrypted.chars,
        }
      : undefined,
  };
}

api.get('/search', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50));
  try {
    const spaces = await spaceAccess.list(identity);
    const requestedSpaceId = optionalText(req.query.spaceId);
    const visibleSpaceIds = requestedSpaceId
      ? spaces.filter((space) => space.id === requestedSpaceId && space.mode === 'web').map((space) => space.id)
      : spaces.filter((space) => space.mode === 'web').map((space) => space.id);
    if (requestedSpaceId && !visibleSpaceIds.length) {
      return res.status(404).json({ error: '空间不存在', code: 'SPACE_NOT_FOUND' });
    }
    res.json({ query: q, results: await store.searchThreadMessages(scope, q, limit, { spaceIds: visibleSpaceIds }) });
  } catch (error) {
    sendSpaceError(res, error);
  }
});

// 创建 thread。
api.post('/threads', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const title = req.body?.title ? String(req.body.title) : undefined;
  try {
    const space = await spaceAccess.requireWritableWebSpace(identity, optionalText(req.body?.spaceId));
    const admission = deletionGate.enter({ tenantId: scope.tenantId, spaceId: space.id });
    try {
      const thread = await store.createThread(scope, title, { spaceId: space.id });
      res.status(201).json(thread);
    } finally {
      admission.finish();
    }
  } catch (error) {
    sendSpaceError(res, error);
  }
});

// 列出 thread。默认只返回未归档列表；设置页通过 archived=1 查看归档列表。
api.get('/threads', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const archived = req.query.archived === '1' || req.query.archived === 'true';
  try {
    const spaces = await spaceAccess.list(identity);
    const requestedSpaceId = optionalText(req.query.spaceId);
    const selectedSpaces = requestedSpaceId ? spaces.filter((space) => space.id === requestedSpaceId) : spaces;
    if (requestedSpaceId && !selectedSpaces.length) {
      return res.status(404).json({ error: '空间不存在', code: 'SPACE_NOT_FOUND' });
    }
    res.json(await store.listThreadsForViewer(scope, 50, {
      archived,
      webSpaceIds: selectedSpaces.filter((space) => space.mode === 'web').map((space) => space.id),
      externalSpaceIds: selectedSpaces.filter((space) => space.mode === 'external').map((space) => space.id),
    }));
  } catch (error) {
    sendSpaceError(res, error);
  }
});

// 管理员查看当前活动分支每个 step 实际固定的模型上下文。
api.get('/threads/:id/context-snapshots', async (req, res) => {
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  if (identity.role !== 'owner' && identity.role !== 'admin') {
    return res.status(403).json({ error: '需要租户管理员权限' });
  }
  let access;
  try {
    access = await threadReadAccess.resolve(identity, req.params.id, optionalText(req.query.spaceId));
  } catch (error) {
    sendThreadReadError(res, error);
    return;
  }
  const rows = await store.listStepContextSummaries(
    access.executionScope,
    access.thread.id,
    { runId: access.thread.active_run_id },
  );
  res.json({
    threadId: access.thread.id,
    activeRunId: access.thread.active_run_id,
    systemPrompt: rows.at(-1)?.system_prompt ?? null,
    contexts: rows.map((row) => ({
      stepId: row.id,
      runId: row.run_id,
      step: row.idx,
      messageCount: row.message_count,
      toolCount: row.tool_count,
      createdAt: row.captured_at,
    })),
  });
});

api.get('/threads/:id/context-snapshots/:stepId', async (req, res) => {
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  if (identity.role !== 'owner' && identity.role !== 'admin') {
    return res.status(403).json({ error: '需要租户管理员权限' });
  }
  let access;
  try {
    access = await threadReadAccess.resolve(identity, req.params.id, optionalText(req.query.spaceId));
  } catch (error) {
    sendThreadReadError(res, error);
    return;
  }
  const row = await store.getStepContext(
    access.executionScope,
    access.thread.id,
    req.params.stepId,
    { runId: access.thread.active_run_id },
  );
  const snapshot = row?.context_snapshot;
  if (!row || !snapshot) return res.status(404).json({ error: 'step 上下文不存在' });
  res.json({
    stepId: row.id,
    runId: row.run_id,
    step: row.idx,
    messageCount: snapshot.messages.length,
    toolCount: snapshot.tools.length,
    messages: snapshot.messages.map(stepContextMessageView),
    tools: snapshot.tools,
    createdAt: snapshot.capturedAt,
  });
});

// thread 详情：包含 run 和事件，用于恢复对话。
api.get('/threads/:id', async (req, res) => {
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const debug = req.query.debug === '1' || req.query.debug === 'true';
  if (debug && identity.role !== 'owner' && identity.role !== 'admin') {
    return res.status(403).json({ error: '需要租户管理员权限' });
  }
  let access;
  try {
    access = await threadReadAccess.resolve(identity, req.params.id, optionalText(req.query.spaceId));
  } catch (error) {
    sendThreadReadError(res, error);
    return;
  }
  const { thread, space, executionScope: scope, readOnly } = access;
  const runs = await store.listRuns(scope, thread.id);
  const withEvents = await Promise.all(
    runs.map(async (run) => ({ ...run, events: await store.getEvents(scope, run.id) })),
  );
  const contextMessages = debug
    ? (await store.loadRawThreadMessages(scope, thread.id)).map((message) => {
        const encrypted = encryptedReasoningStats(message.providerState);
        return {
          id: message.id,
          run_id: message.run_id,
          step_id: message.step_id,
          role: message.role,
          tool_calls: (message.toolCalls ?? []).map((call) => ({
            id: call.id,
            name: call.name,
            argumentChars: call.arguments.length,
            arguments: call.arguments,
          })),
          tool_call_id: message.toolCallId ?? null,
          collapsed: message.collapsed ?? null,
          summary_of: message.summaryOf,
          content_chars: message.content?.length ?? 0,
          content: message.content,
          encrypted_reasoning_count: encrypted.count,
          encrypted_reasoning_chars: encrypted.chars,
          created_at: message.created_at,
        };
      })
    : (await store.loadThreadMessageMetadata(scope, thread.id)).map((message) => ({
        id: message.id,
        run_id: message.run_id,
        step_id: message.step_id,
        role: message.role,
        tool_calls: message.toolCalls,
        tool_call_id: message.toolCallId,
        collapsed: message.collapsed,
        summary_of: message.summaryOf,
        content_chars: message.contentChars,
        content: message.role === 'user' ? message.content : undefined,
        created_at: message.created_at,
      }));
  res.json({
    thread,
    space,
    readOnly,
    runs: withEvents,
    notices: await store.listThreadNotices(scope, thread.id),
    context_messages: contextMessages,
    debug,
  });
});

// 更新 thread 元信息：重命名、置顶/取消置顶、归档/取消归档。
api.patch('/threads/:id', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const existing = await store.getThread(scope, req.params.id);
  if (!existing) return res.status(404).json({ error: 'thread 不存在' });
  if (!await checkThreadSpaceAccess(res, identity, existing.space_id, true)) return;
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
  const thread = await store.updateThread(scope, req.params.id, fields);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  res.json(thread);
});

// thread 下的 subagent 子任务列表。右侧资源栏用它恢复和打开历史 subagent。
api.get('/threads/:id/subagents', async (req, res) => {
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  try {
    const { thread, executionScope } = await threadReadAccess.resolve(
      identity,
      req.params.id,
      optionalText(req.query.spaceId),
    );
    res.json({ subagents: await store.listSubagentRunsByThread(executionScope, thread.id) });
  } catch (error) {
    sendThreadReadError(res, error);
  }
});

// 归档后的 thread 才能永久删除；活动任务先停止，数据库删除后直接清理文件。
api.delete('/threads/:id', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const thread = await store.getThread(scope, req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  if (!await checkThreadSpaceAccess(res, identity, thread.space_id, true)) return;
  if (!thread.archived_at) {
    return res.status(409).json({ error: '只能永久删除已经归档的对话', code: 'THREAD_NOT_ARCHIVED' });
  }
  let deletion: ReturnType<typeof deletionGate.begin> | undefined;
  try {
    deletion = deletionGate.begin({ tenantId: scope.tenantId, threadId: thread.id });
    await deletion.waitForOperations();
    await stopThreadsForDeletion([thread]);
    const deleted: DeleteResourceResult | null = await store.deleteThread(scope, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'thread 不存在' });
    await removeThreadWorkspace(thread.space_id, thread.id);
    await removeExternalArtifacts(deleted.artifactStorageKeys);
  } catch (error) {
    if (error instanceof DeleteConflictError) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    throw error;
  } finally {
    deletion?.finish();
  }
  res.status(204).send();
});

// 在 thread 内启动一次 run。
api.post('/threads/:id/runs', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const thread = await store.getThread(scope, req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  if (!await checkThreadSpaceAccess(res, identity, thread.space_id, true)) return;
  const input = String(req.body?.input ?? '').trim();
  if (!input) return res.status(400).json({ error: 'input 为必填' });
  let run;
  try {
    run = await runAdmission.createWebRun(scope, thread, {
      input,
      requestedModelRef: optionalText(req.body?.modelRef),
      parentRunId: optionalText(req.body?.parentRunId) ?? undefined,
    });
  } catch (err) {
    if (sendRunActiveConflict(res, err)) return;
    if (err instanceof SpaceConfigError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return res.status(400).json({ error: (err as Error).message });
  }
  // 后台执行：agent 循环在当前进程内运行，并通过 WebSocket 推送事件。
  void executeRun(run.id, { scope });
  res.status(201).json({ id: run.id, threadId: thread.id, status: run.status });
});

// --- Runs ---

// run 详情：包含事件，前端按 step 分组展示。
api.get('/runs/:id', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const run = await store.getRun(scope, req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  const thread = await store.getThread(scope, run.thread_id);
  if (!thread || !await checkThreadSpaceAccess(res, identity, thread.space_id, false)) return;
  const events = await store.getEvents(scope, run.id);
  res.json({ run, events });
});

// 从某条历史 run 的父节点创建新分支。旧 run 和其后续分支都保留，但不会进入新 run 上下文。
api.post('/runs/:id/branch', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const source = await store.getRun(scope, req.params.id);
  if (!source) return res.status(404).json({ error: 'run 不存在' });
  const thread = await store.getThread(scope, source.thread_id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  if (!await checkThreadSpaceAccess(res, identity, thread.space_id, true)) return;
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
  let run;
  try {
    run = await runAdmission.createWebRun(scope, thread, {
      input,
      requestedModelRef: optionalText(req.body?.modelRef),
      parentRunId: source.parent_run_id,
    });
  } catch (err) {
    if (sendRunActiveConflict(res, err)) return;
    if (err instanceof SpaceConfigError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return res.status(400).json({ error: (err as Error).message });
  }
  void executeRun(run.id, { scope });
  res.status(201).json({ id: run.id, threadId: source.thread_id, status: run.status });
});

// 从指定用户消息 fork 出新对话：复制当前分支从开头到该用户消息，关联提示只用于 UI 展示。
api.post('/runs/:id/fork', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const source = await store.getRun(scope, req.params.id);
  if (!source) return res.status(404).json({ error: 'run 不存在' });
  const sourceThread = await store.getThread(scope, source.thread_id);
  if (!sourceThread) return res.status(404).json({ error: 'thread 不存在' });
  if (!await checkThreadSpaceAccess(res, identity, sourceThread.space_id, true)) return;
  let fork: Awaited<ReturnType<typeof store.forkThreadAtRun>>;
  try {
    const admission = deletionGate.enter({ tenantId: scope.tenantId, spaceId: sourceThread.space_id, threadId: sourceThread.id });
    try {
      fork = await store.forkThreadAtRun(scope, req.params.id);
    } finally {
      admission.finish();
    }
  } catch (error) {
    if (sendRunActiveConflict(res, error)) return;
    throw error;
  }
  if (!fork) return res.status(404).json({ error: 'run 不存在' });
  res.status(201).json({
    thread: fork.thread,
    activeRun: { ...fork.activeRun, events: await store.getEvents(scope, fork.activeRun.id) },
  });
});

// 取消 run。运行中的 run 走协作式取消；等待用户回答时 executor 已暂停，
// 需要直接落成 canceled，避免刷新后继续卡在 ask_user。
api.post('/runs/:id/cancel', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const run = await store.getRun(scope, req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  const thread = await store.getThread(scope, run.thread_id);
  if (!thread || !await checkThreadSpaceAccess(res, identity, thread.space_id, true)) return;
  if (run.status === 'waiting_for_user') {
    const step = (await store.getLastStepIndex(scope, run.id)) + 1;
    await killRunShellCommands(scope, run.id);
    await store.addEvent(scope, run.id, null, { type: 'user_cancel', step, reason: '用户已取消 run。' });
    await store.setRunStatus(scope, run.id, 'canceled', { error: '用户已取消 run。' });
    await releaseRunLeases(run.id);
    return res.json({ id: run.id, status: 'canceled' });
  }
  if (run.status === 'pending' || run.status === 'running') {
    await killRunShellCommands(scope, run.id);
    await store.setRunStatus(scope, run.id, 'canceling');
    abortRunExecution(run.id);
    return res.json({ id: run.id, status: 'canceling' });
  }
  res.json({ id: run.id, status: run.status });
});

// 继续同一个 run：用于网络错误、服务重启后恢复失败等场景。
// 模型上下文只使用已完整落库的 messages；半截流式事件保留审计，不作为续跑输入。
api.post('/runs/:id/continue', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const run = await store.getRun(scope, req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  const thread = await store.getThread(scope, run.thread_id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  if (!await checkThreadSpaceAccess(res, identity, thread.space_id, true)) return;
  if (thread.active_run_id !== run.id) {
    return res.status(409).json({ error: '只能继续当前分支最后一条 run' });
  }
  if (run.status !== 'error' && run.status !== 'pending') {
    return res.status(409).json({ error: `run 当前状态为 ${run.status}，不能继续生成` });
  }

  const lastStep = await store.getLastStepIndex(scope, run.id);
  const lastCompletedStep = await store.getLastCompletedStepIndex(scope, run.id);
  const message = lastStep > lastCompletedStep
    ? `正在继续生成：从第 ${lastCompletedStep} 个完整 step 后恢复；未完整落库的 step 只保留为事件审计，不进入模型上下文。`
    : '正在继续生成：从最近的持久化检查点恢复。';
  try {
    const admission = deletionGate.enter({ tenantId: scope.tenantId, spaceId: thread.space_id, threadId: thread.id });
    try {
      const resumed = await store.resumeRun(scope, run.id, ['error', 'pending'], { output: null, error: null });
      if (!resumed) return res.status(409).json({ error: 'run 状态已变化，不能重复继续生成' });
      await store.addEvent(scope, run.id, null, { type: 'recovery', step: lastStep + 1, message });
      void executeRun(run.id, { resume: true, scope });
    } finally {
      admission.finish();
    }
  } catch (err) {
    if (sendRunActiveConflict(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
  res.json({ id: run.id, threadId: run.thread_id, status: 'running' });
});

// 回答暂停中的 run，并恢复同一个 run。空回答表示“按默认假设继续”。
api.post('/runs/:id/answer', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const run = await store.getRun(scope, req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在' });
  const thread = await store.getThread(scope, run.thread_id);
  if (!thread || !await checkThreadSpaceAccess(res, identity, thread.space_id, true)) return;
  if (run.status !== 'waiting_for_user') return res.status(409).json({ error: `run 当前状态为 ${run.status}，不是 waiting_for_user` });

  const spec = latestAskUserSpec(await store.getEvents(scope, run.id));
  const answer = normalizeAnswer(req.body?.answer, spec);
  const invalid = validateAnswer(answer, spec);
  if (invalid) return res.status(400).json({ error: invalid });
  const answerContent = `用户回答：\n${formatAnswerForModel(answer)}`;
  let userMessage: Awaited<ReturnType<typeof store.loadThreadMessageMetadata>>[number] | undefined;
  try {
    const admission = deletionGate.enter({ tenantId: scope.tenantId, spaceId: thread.space_id, threadId: thread.id });
    try {
      const resumed = await store.resumeRun(scope, run.id, ['waiting_for_user'], { userMessageContent: answerContent });
      if (!resumed) return res.status(409).json({ error: 'run 状态已变化，不能重复提交回答' });
      userMessage = (await store.loadThreadMessageMetadata(scope, thread.id, { runId: run.id }))
        .filter((message) => message.run_id === run.id && message.role === 'user')
        .at(-1);
      if (!userMessage || userMessage.content == null) {
        throw new Error(`恢复 run ${run.id} 后缺少持久化用户消息`);
      }
      await store.addEvent(scope, run.id, null, { type: 'user_answer', step: (await store.getLastStepIndex(scope, run.id)) + 1, answer });
      void executeRun(run.id, { resume: true, scope });
    } finally {
      admission.finish();
    }
  } catch (err) {
    if (sendRunActiveConflict(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
  res.json({
    id: run.id,
    threadId: run.thread_id,
    status: 'running',
    userMessage: {
      id: userMessage.id,
      content: userMessage.content,
      createdAt: userMessage.created_at,
    },
  });
});

// --- Managed shell ---

async function webThreadToolSettings(
  res: Response,
  identity: Extract<IdentityContext, { scope: 'tenant' }>,
  threadId: string,
): Promise<ToolSettings | null> {
  try {
    const workspace = await threadWorkspaceAccess.resolveForWeb(identity, threadId, 'write');
    return { ...(await getSystemToolSettings()), workspaceRoot: workspace.root };
  } catch (error) {
    if (error instanceof DeleteConflictError) {
      res.status(409).json({ error: error.message, code: error.code });
      return null;
    }
    if (error instanceof ThreadWorkspaceAccessError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return null;
    }
    throw error;
  }
}

async function webShellSessionSettings(
  res: Response,
  identity: Extract<IdentityContext, { scope: 'tenant' }>,
  session: ShellSessionRow,
): Promise<ToolSettings | null> {
  const settings = await webThreadToolSettings(res, identity, session.thread_id);
  if (!settings) return null;
  if (resolve(session.workspace_root) !== resolve(settings.workspaceRoot)) {
    res.status(409).json({ error: 'shell session 不属于当前 thread workspace，请重新打开 session' });
    return null;
  }
  return settings;
}

api.get('/shell-sessions', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const threadId = String(req.query.threadId ?? '').trim();
  if (!threadId) return res.status(400).json({ error: 'threadId 为必填' });
  const settings = await webThreadToolSettings(res, identity, threadId);
  if (!settings) return;
  const sessions = await shellManager.listSessions(scope, threadId, settings);
  const result = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      commands: await store.listShellCommandsBySession(scope, session.id, 50),
    })),
  );
  res.json({ sessions: result });
});

api.post('/shell-sessions', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const threadId = String(req.body?.threadId ?? '').trim();
  if (!threadId) return res.status(400).json({ error: 'threadId 为必填' });
  const settings = await webThreadToolSettings(res, identity, threadId);
  if (!settings) return;
  const decision = createPolicy(settings).check('shell_session_open', { command: '' });
  if (!decision.ok) return res.status(403).json({ error: decision.reason });
  const session = await shellManager.openSession({
    scope,
    threadId,
    settings,
    owner: 'user',
    name: typeof req.body?.name === 'string' ? req.body.name : undefined,
  });
  res.status(201).json({ session });
});

api.patch('/shell-sessions/:id', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const session = await store.getShellSession(scope, req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  if (!await webShellSessionSettings(res, identity, session)) return;
  if (session.deleted_at) return res.status(404).json({ error: 'shell session 已删除' });
  if (session.name === 'Default' || session.owner === 'system') return res.status(403).json({ error: 'Default shell 不支持改名' });
  if (session.owner !== 'user') return res.status(403).json({ error: '用户不能改名 agent 创建的 shell' });
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name 为必填' });
  if (name === 'Default') return res.status(400).json({ error: 'Default 是系统保留名称' });
  const siblings = await store.listShellSessions(scope, session.thread_id, session.workspace_root);
  if (siblings.some((item) => item.id !== session.id && item.name === name)) {
    return res.status(409).json({ error: `shell 名称已存在：${name}` });
  }
  await store.updateShellSession(scope, session.id, { name });
  await store.addShellSessionEvent(scope, session.id, 'user', 'renamed', { name });
  res.json({ session: await store.getShellSession(scope, session.id) });
});

api.get('/shell-sessions/:id/commands', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const session = await store.getShellSession(scope, req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  res.json({ session, commands: await store.listShellCommandsBySession(scope, session.id, limit) });
});

api.post('/shell-sessions/:id/close', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const session = await store.getShellSession(scope, req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  if (!await webShellSessionSettings(res, identity, session)) return;
  if (session.name === 'Default' || session.owner === 'system') return res.status(403).json({ error: 'Default shell 不支持删除' });
  if (session.owner !== 'user') return res.status(403).json({ error: '用户不能删除 agent 创建的 shell' });
  const commands = await store.listShellCommandsBySession(scope, session.id, 50);
  const running = commands.filter((cmd) => cmd.status === 'queued' || cmd.status === 'running');
  if (running.length && req.body?.force !== true) {
    return res.status(409).json({ error: `shell session 仍有运行中命令：${running.map((cmd) => cmd.id).join(', ')}` });
  }
  for (const command of running) {
    await shellManager.kill(scope, command.id, 'session_close', 'SIGTERM');
  }
  await store.updateShellSession(scope, session.id, { status: 'closed', lease_actor: null, lease_run_id: null, deleted_at: new Date().toISOString() });
  await store.addShellSessionEvent(scope, session.id, 'user', 'deleted', { force: req.body?.force === true });
  shellBus.publish(session.thread_id, { type: 'shell_session_closed', step: 0, sessionId: session.id, reason: '用户关闭 session。' });
  res.json({ session: await store.getShellSession(scope, session.id) });
});

api.post('/shell-sessions/:id/commands', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const session = await store.getShellSession(scope, req.params.id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  const command = String(req.body?.command ?? '').trim();
  if (!command) return res.status(400).json({ error: 'command 为必填' });
  const settings = await webShellSessionSettings(res, identity, session);
  if (!settings) return;
  const policy = createPolicy(settings);
  const decision = policy.check('shell_exec', { command });
  if (!decision.ok) return res.status(403).json({ error: decision.reason });
  const result = await shellManager.exec({
    scope,
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
  const scope = scopeOrReject(res);
  if (!scope) return;
  const command = await store.getShellCommand(scope, req.params.id);
  if (!command) return res.status(404).json({ error: 'shell command 不存在' });
  const sinceSeq = Math.max(0, Number(req.query.sinceSeq ?? 0));
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
  res.json({ command, logs: await store.getShellCommandLogs(scope, command.id, sinceSeq, limit) });
});

api.post('/shell-commands/:id/mark', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const command = await store.getShellCommand(scope, req.params.id);
  if (!command) return res.status(404).json({ error: 'shell command 不存在' });
  if (command.status === 'queued' || command.status === 'running') {
    return res.status(409).json({ error: 'shell command 仍在运行，结束后才能标记' });
  }
  const session = await store.getShellSession(scope, command.session_id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  const settings = await webShellSessionSettings(res, identity, session);
  if (!settings) return;
  let operation: ReturnType<typeof deletionGate.enter> | undefined;
  try {
    operation = deletionGate.enter({ tenantId: scope.tenantId, threadId: session.thread_id });
    const logs = await readAllShellCommandLogs(scope, command.id);
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
  } catch (error) {
    if (sendRunActiveConflict(res, error)) return;
    throw error;
  } finally {
    operation?.finish();
  }
});

api.post('/shell-commands/:id/kill', async (req, res) => {
  const scope = scopeOrReject(res);
  if (!scope) return;
  const identity = tenantIdentityOrReject(res);
  if (!identity) return;
  const existing = await store.getShellCommand(scope, req.params.id);
  if (!existing) return res.status(404).json({ error: 'shell command 不存在' });
  const session = await store.getShellSession(scope, existing.session_id);
  if (!session) return res.status(404).json({ error: 'shell session 不存在' });
  if (!await webShellSessionSettings(res, identity, session)) return;
  const signal = normalizeShellSignal(req.body?.signal, 'SIGTERM');
  const command = await shellManager.kill(scope, req.params.id, String(req.body?.reason ?? 'user_requested_kill'), signal);
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
