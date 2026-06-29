import type { UIMessage } from 'ai';
import { Bot, Circle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listSubagentRuns, type SubagentRun } from '@/api';
import { Button } from '@/components/ui/button';
import { Conversation } from './Conversation';
import type { AskUserAnswer } from '@/api';
import type { AskUserDraft } from './AskUserCard';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  threadId: string | null;
  subagentId: string | null;
  workspaceRoot: string | null;
  onOpenRemoteFile: (path: string) => void;
}

function statusLabel(status: SubagentRun['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'done') return '已完成';
  return '失败';
}

function statusIcon(status: SubagentRun['status']) {
  if (status === 'running') return <LoaderCircle className="size-3.5 animate-spin text-foreground" />;
  if (status === 'done') return <Circle className="size-3.5 fill-foreground text-foreground" />;
  return <Circle className="size-3.5 fill-destructive text-destructive" />;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function subagentTitle(row: SubagentRun): string {
  const task = textValue(row.task_assignment.task);
  return task || row.stage_id || row.id;
}

function subagentInput(row: SubagentRun): string {
  const lines = [
    row.stage_id ? `阶段：${row.stage_id}` : null,
    row.runtime_profile_id ? `运行配置：${row.runtime_profile_id}` : null,
    row.skill_names.length ? `Skills：${row.skill_names.join(', ')}` : null,
    textValue(row.task_assignment.stageGoal) ? `阶段目标：${textValue(row.task_assignment.stageGoal)}` : null,
    textValue(row.task_assignment.task) ? `任务：${textValue(row.task_assignment.task)}` : null,
    textValue(row.task_assignment.context) ? `上下文：\n${textValue(row.task_assignment.context)}` : null,
    textValue(row.task_assignment.expectedOutput) ? `期望输出：${textValue(row.task_assignment.expectedOutput)}` : null,
    textValue(row.task_assignment.constraints) ? `限制：${textValue(row.task_assignment.constraints)}` : null,
  ].filter(Boolean);
  return lines.join('\n\n') || row.id;
}

function messagesFor(row: SubagentRun | null): UIMessage[] {
  if (!row) return [];
  const output = row.status === 'running'
    ? 'subagent 正在运行，等待输出。'
    : row.error
      ? `subagent 执行失败：${row.error}`
      : row.output ?? 'subagent 未返回输出。';
  return [
    {
      id: `${row.id}:u`,
      role: 'user',
      parts: [
        { type: 'text', text: subagentInput(row) },
        { type: 'data-message-time', id: `time-${row.id}:u`, data: { sentAt: row.created_at } } as unknown as UIMessage['parts'][number],
      ],
    },
    {
      id: `${row.id}:a`,
      role: 'assistant',
      parts: [
        { type: 'data-run-id', id: row.id, data: { runId: row.id } } as unknown as UIMessage['parts'][number],
        { type: 'text', text: output, state: 'done' },
        {
          type: 'data-message-time',
          id: `time-${row.id}:a`,
          data: { completedAt: row.finished_at ?? row.updated_at },
        } as unknown as UIMessage['parts'][number],
      ],
    },
  ];
}

export function SubagentPanel({ open, threadId, subagentId, workspaceRoot, onOpenRemoteFile }: Props) {
  const [subagents, setSubagents] = useState<SubagentRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!open || !threadId) {
      setSubagents([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await listSubagentRuns(threadId);
      setSubagents(data.subagents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [open, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open || !threadId) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [open, refresh, threadId]);

  const selected = useMemo(
    () => subagents.find((item) => item.id === subagentId) ?? subagents[0] ?? null,
    [subagentId, subagents],
  );
  const messages = useMemo(() => messagesFor(selected), [selected]);
  const askUserDrafts = useMemo<Record<string, AskUserDraft>>(() => ({}), []);
  const noopDraft = useCallback(() => {}, []);
  const noopSubmit = useCallback((_runId: string, _answer: AskUserAnswer) => {}, []);
  const noopCancel = useCallback(() => {}, []);
  const noopRun = useCallback((_runId: string) => {}, []);
  const noopEdit = useCallback((_runId: string, _currentText: string) => {}, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={selected ? subagentTitle(selected) : 'Subagent'}>
            {selected ? subagentTitle(selected) : 'Subagent'}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {selected && statusIcon(selected.status)}
            <span className="truncate">{selected ? `${statusLabel(selected.status)} · ${selected.id}` : '暂无子任务'}</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => void refresh()} disabled={loading} title="刷新 subagent">
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </header>

      {error && <div className="shrink-0 border-b px-3 py-2 text-xs text-destructive">{error}</div>}

      <div className="min-h-0 flex-1">
        <Conversation
          messages={messages}
          busy={selected?.status === 'running'}
          wide={false}
          embedded
          showToc={false}
          emptyTitle="暂无 subagent"
          emptyDescription="当前会话还没有可查看的 subagent 子任务。"
          workspaceRoot={workspaceRoot}
          contentRef={contentRef}
          askUserDrafts={askUserDrafts}
          onOpenRemoteFile={onOpenRemoteFile}
          onOpenThread={noopRun}
          onAskUserDraftChange={noopDraft}
          onAskUserSubmit={noopSubmit}
          onAskUserCancel={noopCancel}
          onSwitchRunBranch={noopRun}
          onEditRunInput={noopEdit}
          onForkFromRun={noopRun}
        />
      </div>
    </div>
  );
}
