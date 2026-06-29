// 把 REST 加载的持久化 run 历史转换成 AI SDK UIMessage，便于切换/刷新会话后恢复。
// 每个 run 会变成一条用户消息和一条由事件折叠出来的 assistant 消息。

import type { UIMessage } from 'ai';
import type { RunWithEvents, StreamStats, ThreadNotice } from './api';
import { toUiEvent } from './transport/legacy';
import type { UiEvent } from './transport/types';

type Part = UIMessage['parts'][number];

export interface RunBranchInfo {
  runId: string;
  parentRunId: string | null;
  siblingRunIds: string[];
  activeIndex: number;
  count: number;
  canEdit: boolean;
}

export interface ThreadNoticeData {
  kind: string;
  prefix: string;
  suffix: string;
  threadTitle: string;
  linkedThreadId: string | null;
  href: string | null;
}

function noticeThreadTitle(notice: ThreadNotice): string {
  const title = notice.title?.trim();
  if (!title) return notice.kind === 'fork_from' ? '未命名对话' : '新对话';
  if (title === '打开新对话') return '新对话';
  if (title === '打开原对话') return '未命名对话';
  return title.replace(/^打开(?:原|新)对话[:：]\s*/, '');
}

function noticeData(notice: ThreadNotice): ThreadNoticeData {
  const href = notice.linked_thread_id ? `/chat/${encodeURIComponent(notice.linked_thread_id)}` : null;
  if (notice.kind === 'fork_from') {
    return {
      kind: notice.kind,
      prefix: '从',
      suffix: ' fork',
      threadTitle: noticeThreadTitle(notice),
      linkedThreadId: notice.linked_thread_id,
      href,
    };
  }
  if (notice.kind === 'fork_to') {
    return {
      kind: notice.kind,
      prefix: '已 fork 到',
      suffix: '',
      threadTitle: noticeThreadTitle(notice),
      linkedThreadId: notice.linked_thread_id,
      href,
    };
  }
  return {
    kind: notice.kind,
    prefix: notice.message.replace(/(?:th|ru)_[0-9A-Za-z]+/g, '').replace(/\s+/g, ' ').trim(),
    suffix: '',
    threadTitle: noticeThreadTitle(notice),
    linkedThreadId: notice.linked_thread_id,
    href,
  };
}

/** 把有序 UiEvent 折叠成线性 parts；连续文本/思考会合并，工具输入输出按 id 合并。 */
export function foldUiEventsToParts(events: UiEvent[]): Part[] {
  const parts: Part[] = [];
  const toolById = new Map<string, Record<string, unknown>>();
  let textBuf = '';
  let reasonBuf = '';
  let reasonStep: number | null = null;
  let reasonTiming: { startedAt?: string; endedAt?: string; durationMs?: number } = {};
  let latestStats: StreamStats | null = null;

  const flushText = () => {
    if (textBuf) {
      parts.push({ type: 'text', text: textBuf, state: 'done' });
      textBuf = '';
    }
  };
  const flushReason = () => {
    if (reasonBuf) {
      const id = `r-${reasonStep ?? parts.length}`;
      parts.push({ type: 'reasoning', id, text: reasonBuf, state: 'done', step: reasonStep, ...reasonTiming } as unknown as Part);
      if (reasonTiming.startedAt && reasonTiming.endedAt) {
        parts.push({
          type: 'data-reasoning-timing',
          id,
          data: { step: reasonStep, ...reasonTiming },
        } as unknown as Part);
      }
      reasonBuf = '';
      reasonStep = null;
      reasonTiming = {};
    }
  };

  for (const e of events) {
    switch (e.kind) {
      case 'stream_stats':
        latestStats = e.stats;
        break;
      case 'usage_update':
        parts.push({ type: 'data-usage-update', id: `usage-${e.step}`, data: e.usage } as unknown as Part);
        break;
      case 'reasoning':
        flushText();
        reasonStep = e.step;
        if (e.startedAt || e.endedAt || e.durationMs !== undefined) {
          reasonTiming = { startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs };
        }
        reasonBuf += e.delta;
        break;
      case 'reasoning_timing':
        reasonTiming = { startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs };
        if (!reasonBuf) {
          parts.push({
            type: 'data-reasoning-timing',
            id: `r-${e.step}`,
            data: { step: e.step, ...reasonTiming },
          } as unknown as Part);
        }
        break;
      case 'text':
        flushReason();
        textBuf += e.delta;
        break;
      case 'notice':
        flushReason();
        flushText();
        parts.push({ type: 'text', text: e.message, state: 'done' });
        break;
      case 'ask_user_question':
        flushReason();
        flushText();
        parts.push({ type: 'data-ask-user-question', id: `ask-${e.step}`, data: e.spec } as unknown as Part);
        break;
      case 'ask_user_answer':
        flushReason();
        flushText();
        parts.push({ type: 'data-ask-user-answer', id: `answer-${e.step}`, data: e.answer } as unknown as Part);
        break;
      case 'ask_user_cancel':
        flushReason();
        flushText();
        parts.push({ type: 'data-ask-user-cancel', id: `cancel-${e.step}`, data: { reason: e.reason } } as unknown as Part);
        break;
      case 'tool': {
        flushReason();
        flushText();
        let p = toolById.get(e.id);
        if (!p) {
          p = {
            type: 'dynamic-tool',
            toolName: e.name,
            toolCallId: e.id,
            state: 'input-available',
            input: e.input,
            step: e.step,
            startedAt: e.startedAt,
          };
          toolById.set(e.id, p);
          parts.push(p as unknown as Part);
        }
        if (e.input !== undefined) p.input = e.input;
        if (e.startedAt) p.startedAt = e.startedAt;
        if (e.output !== undefined) {
          p.output = e.output;
          p.state = 'output-available';
          p.endedAt = e.endedAt;
          p.durationMs = e.durationMs;
          if (e.startedAt && e.endedAt) {
            parts.push({
              type: 'data-tool-timing',
              id: e.id,
              data: { id: e.id, step: e.step, startedAt: e.startedAt, endedAt: e.endedAt, durationMs: e.durationMs },
            } as unknown as Part);
          }
        }
        break;
      }
      case 'plan_update':
        flushReason();
        flushText();
        parts.push({ type: 'data-plan-state', id: `plan-${e.step}`, data: e.goal } as unknown as Part);
        break;
      case 'final':
        flushReason();
        if (textBuf) flushText();
        else if (e.output) parts.push({ type: 'text', text: e.output, state: 'done' });
        parts.push({ type: 'data-final-output', id: `final-${e.step}`, data: { step: e.step, output: e.output } } as unknown as Part);
        break;
      case 'error':
        flushReason();
        flushText();
        parts.push({ type: 'text', text: `⚠️ ${e.message}`, state: 'done' });
        break;
      case 'step_start':
        break;
    }
  }
  flushReason();
  flushText();
  if (latestStats) {
    parts.push({ type: 'data-stream-stats', id: `stats-${latestStats.updatedAt}`, data: latestStats } as unknown as Part);
  }
  return parts;
}

function terminalStats(run: RunWithEvents): StreamStats | null {
  const terminalStage = run.status === 'done' ? 'done' : run.status === 'error' || run.status === 'canceled' ? 'error' : null;
  if (!terminalStage) return null;
  const outputChars = run.output?.length ?? 0;
  const errorChars = run.error?.length ?? 0;
  return {
    stage: terminalStage,
    updatedAt: run.updated_at,
    totals: {
      outputChars,
      reasoningChars: 0,
      toolInputChars: 0,
      toolOutputChars: 0,
      totalChars: outputChars + errorChars,
    },
    rate: { charsPerSecond: 0, history: [] },
  };
}

function isTerminalRun(run: RunWithEvents): boolean {
  return run.status === 'done' || run.status === 'error' || run.status === 'canceled';
}

function activePathRuns(runs: RunWithEvents[], activeRunId?: string | null): RunWithEvents[] {
  if (!activeRunId) return runs;
  const byId = new Map(runs.map((run) => [run.id, run]));
  const path: RunWithEvents[] = [];
  const seen = new Set<string>();
  let cursor: string | null = activeRunId;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const run = byId.get(cursor);
    if (!run) return runs;
    path.push(run);
    cursor = run.parent_run_id;
  }
  return path.reverse();
}

function branchInfoFor(run: RunWithEvents, runs: RunWithEvents[], editableRunId: string | null): RunBranchInfo {
  const siblings = runs
    .filter((item) => item.parent_run_id === run.parent_run_id)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const siblingRunIds = siblings.map((item) => item.id);
  const index = Math.max(0, siblingRunIds.indexOf(run.id));
  return {
    runId: run.id,
    parentRunId: run.parent_run_id,
    siblingRunIds,
    activeIndex: index,
    count: siblingRunIds.length,
    canEdit: run.id === editableRunId,
  };
}

function noticeMessage(notice: ThreadNotice): UIMessage {
  return {
    id: `notice-${notice.id}`,
    role: 'assistant',
    parts: [
      { type: 'data-thread-notice', id: `thread-notice-${notice.id}`, data: noticeData(notice) } as unknown as Part,
      { type: 'data-message-time', id: `time-notice-${notice.id}`, data: { completedAt: notice.created_at } } as unknown as Part,
    ],
  };
}

/** 把按时间排序的持久化 runs 映射成当前分支的扁平 UIMessage 列表。 */
export function runsToUiMessages(runs: RunWithEvents[], activeRunId?: string | null, notices: ThreadNotice[] = []): UIMessage[] {
  const messages: UIMessage[] = [];
  const visibleRuns = activePathRuns(runs, activeRunId);
  const editableRunId = activeRunId ?? visibleRuns[visibleRuns.length - 1]?.id ?? null;
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id));
  const noticesByRun = new Map<string, ThreadNotice[]>();
  const trailingNotices: ThreadNotice[] = [];
  for (const notice of notices) {
    if (notice.linked_run_id && visibleRunIds.has(notice.linked_run_id)) {
      noticesByRun.set(notice.linked_run_id, [...(noticesByRun.get(notice.linked_run_id) ?? []), notice]);
    } else {
      trailingNotices.push(notice);
    }
  }
  for (const run of visibleRuns) {
    messages.push({
      id: `${run.id}:u`,
      role: 'user',
      parts: [
        { type: 'text', text: run.input },
        { type: 'data-branch-info', id: `branch-${run.id}`, data: branchInfoFor(run, runs, editableRunId) } as unknown as Part,
        { type: 'data-message-time', id: `time-${run.id}:u`, data: { sentAt: run.created_at } } as unknown as Part,
      ],
    });
    const parts = foldUiEventsToParts(
      run.events.map(toUiEvent).filter((e): e is UiEvent => e !== null),
    );
    if (run.goal_state?.plan?.length && !parts.some((part) => part.type === 'data-plan-state')) {
      parts.unshift({ type: 'data-plan-state', id: `plan-${run.id}`, data: run.goal_state } as unknown as Part);
    }
    if (!parts.some((part) => part.type === 'data-stream-stats')) {
      const stats = terminalStats(run);
      if (stats) parts.push({ type: 'data-stream-stats', id: `stats-${run.id}`, data: stats } as unknown as Part);
    }
    if (parts.length) {
      parts.unshift({ type: 'data-run-id', id: run.id, data: { runId: run.id } } as unknown as Part);
      if (isTerminalRun(run)) {
        parts.push({ type: 'data-message-time', id: `time-${run.id}:a`, data: { completedAt: run.updated_at } } as unknown as Part);
      }
      messages.push({ id: `${run.id}:a`, role: 'assistant', parts });
    }
    for (const notice of noticesByRun.get(run.id) ?? []) {
      messages.push(noticeMessage(notice));
    }
  }
  for (const notice of trailingNotices) {
    messages.push(noticeMessage(notice));
  }
  return messages;
}
