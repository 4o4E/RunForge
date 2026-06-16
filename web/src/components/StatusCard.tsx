import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UIMessage } from 'ai';
import { Bot, CheckCircle2, Circle, Gauge, LoaderCircle, Settings2, Terminal, XCircle } from 'lucide-react';
import { listShellSessions, listSubagentRuns, type PlanItem, type ShellSession, type SubagentRun } from '@/api';
import { Button } from '@/components/ui/button';
import { latestPlanState, type UsageSnapshot } from './Conversation';
import { cn } from '@/lib/utils';

type StatusField = 'run' | 'plan' | 'shell' | 'tokens' | 'cache';

interface Props {
  messages: UIMessage[];
  busy: boolean;
  threadId: string | null;
  className?: string;
  onOpenShellPreview?: (sessionId: string) => void;
  onOpenSubagentPreview?: (subagentId: string) => void;
}

const STORAGE_KEY = 'my-agent:right-status-fields';
const DEFAULT_FIELDS: StatusField[] = ['run', 'plan', 'shell', 'tokens', 'cache'];
const FIELD_LABELS: Record<StatusField, string> = {
  run: '当前信息',
  plan: '计划',
  shell: '资源',
  tokens: 'Token',
  cache: '缓存命中率',
};

function formatNumber(value?: number): string {
  return value == null ? '暂无' : value.toLocaleString();
}

function formatPercent(numerator?: number, denominator?: number): string {
  if (numerator == null || denominator == null || denominator <= 0) return '暂无';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function usageFromPart(part: UIMessage['parts'][number]): UsageSnapshot | null {
  const candidate = part as { type: string; data?: UsageSnapshot };
  return candidate.type === 'data-usage-update' ? candidate.data ?? null : null;
}

function hasTokenUsage(usage: UsageSnapshot): boolean {
  return usage.inputTokens != null || usage.outputTokens != null || usage.cachedInputTokens != null;
}

function latestTokenUsage(messages: UIMessage[]): UsageSnapshot | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = messages[messageIndex].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const usage = usageFromPart(parts[partIndex]);
      if (usage && hasTokenUsage(usage)) return usage;
    }
  }
  return null;
}

function readFields(): StatusField[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      const fields = parsed.filter((item): item is StatusField => DEFAULT_FIELDS.includes(item));
      if (fields.length) return fields;
    }
  } catch {
    // 展示配置损坏时回到默认项。
  }
  return DEFAULT_FIELDS;
}

function StatusRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium text-foreground" title={title ?? value}>{value}</span>
    </div>
  );
}

function ResourceDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function subagentLabel(subagent: SubagentRun): string {
  const task = typeof subagent.task_assignment.task === 'string' ? subagent.task_assignment.task.trim() : '';
  return task || subagent.stage_id || subagent.id;
}

function planIcon(item: PlanItem) {
  if (item.status === 'done') return <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
  if (item.status === 'doing') return <LoaderCircle className="size-3.5 animate-spin text-sky-600 dark:text-sky-400" />;
  if (item.status === 'failed') return <XCircle className="size-3.5 text-destructive" />;
  return <Circle className="size-3.5 text-muted-foreground" />;
}

function PlanList({ messages }: { messages: UIMessage[] }) {
  const goal = latestPlanState(messages);
  if (!goal?.plan?.length) return <StatusRow label="任务计划" value="暂无" />;
  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">任务计划</span>
        <span className="font-medium text-foreground">{goal.phase ?? 'working'}</span>
      </div>
      <div className="max-h-28 space-y-1 overflow-auto pr-1">
        {goal.plan.map((item, index) => (
          <div key={`${item.text}:${index}`} className="flex min-h-5 min-w-0 items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">{planIcon(item)}</span>
            <span className={cn('min-w-0 flex-1 break-words', item.status === 'done' && 'text-muted-foreground')}>{item.text}</span>
          </div>
        ))}
      </div>
      {goal.next && <div className="truncate text-xs text-muted-foreground">下一步：{goal.next}</div>}
    </div>
  );
}

export function AgentStatusCard({ messages, busy, threadId, className, onOpenShellPreview, onOpenSubagentPreview }: Props) {
  const [fields, setFields] = useState<StatusField[]>(readFields);
  const [configOpen, setConfigOpen] = useState(false);
  const [sessions, setSessions] = useState<ShellSession[]>([]);
  const [subagents, setSubagents] = useState<SubagentRun[]>([]);
  const usage = latestTokenUsage(messages);
  const messageSummary = useMemo(() => {
    const userCount = messages.filter((message) => message.role === 'user').length;
    const assistantCount = messages.filter((message) => message.role === 'assistant').length;
    return `${userCount} 轮提问 · ${assistantCount} 条回复`;
  }, [messages]);
  const openShells = sessions.filter((session) => session.status !== 'closed');
  const visibleSubagents = subagents.slice(-6);

  const refreshShells = useCallback(() => {
    if (!threadId) {
      setSessions([]);
      return;
    }
    listShellSessions(threadId).then((data) => setSessions(data.sessions)).catch(() => setSessions([]));
  }, [threadId]);

  const refreshSubagents = useCallback(() => {
    if (!threadId) {
      setSubagents([]);
      return;
    }
    listSubagentRuns(threadId).then((data) => setSubagents(data.subagents)).catch(() => setSubagents([]));
  }, [threadId]);

  useEffect(refreshShells, [refreshShells]);
  useEffect(refreshSubagents, [refreshSubagents]);
  useEffect(() => {
    if (!threadId) return;
    const timer = window.setInterval(() => {
      refreshShells();
      refreshSubagents();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshShells, refreshSubagents, threadId]);

  const toggleField = (field: StatusField) => {
    setFields((current) => {
      const next = current.includes(field) ? current.filter((item) => item !== field) : [...current, field];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next.length ? next : DEFAULT_FIELDS));
      return next.length ? next : DEFAULT_FIELDS;
    });
  };

  const show = (field: StatusField) => fields.includes(field);

  return (
    <section className={cn('w-64 rounded-md border bg-card p-2.5 shadow-lg', className)}>
      <div className="mb-2 flex items-center gap-2">
        <div className={cn('flex size-8 items-center justify-center rounded-md border', busy ? 'text-primary' : 'text-muted-foreground')}>
          <Gauge className={cn('size-4', busy && 'animate-pulse')} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{busy ? '运行中' : '空闲'}</div>
          <div className="truncate text-xs text-muted-foreground">状态卡片</div>
        </div>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => setConfigOpen((open) => !open)} title="配置状态卡片">
          <Settings2 className="size-4" />
        </Button>
      </div>

      {configOpen && (
        <div className="mb-2 grid grid-cols-2 gap-1 rounded-md border bg-background p-2">
          {DEFAULT_FIELDS.map((field) => (
            <label key={field} className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={fields.includes(field)} onChange={() => toggleField(field)} />
              <span>{FIELD_LABELS[field]}</span>
            </label>
          ))}
        </div>
      )}

      <div className="space-y-1">
        {show('run') && (
          <>
            <StatusRow label="状态" value={busy ? '运行中' : '空闲'} />
            <StatusRow label="消息" value={messageSummary} />
          </>
        )}
        {show('plan') && <PlanList messages={messages} />}
        {show('tokens') && (
          <StatusRow
            label="token"
            value={`读 ${formatNumber(usage?.inputTokens)} · 写 ${formatNumber(usage?.outputTokens)}`}
            title="排序逻辑：读表示本轮模型输入 token，写表示本轮模型输出 token，按读/写顺序展示。"
          />
        )}
        {show('cache') && (
          <StatusRow
            label="缓存命中率"
            value={formatPercent(usage?.cachedInputTokens, usage?.inputTokens)}
            title={`缓存命中 token / 输入 token：${formatNumber(usage?.cachedInputTokens)} / ${formatNumber(usage?.inputTokens)}`}
          />
        )}
      </div>

      {show('shell') && (openShells.length > 0 || visibleSubagents.length > 0) && (
        <div className="mt-2 space-y-1.5">
          {openShells.length > 0 && (
            <>
              <ResourceDivider label="Shell" />
              <div className="flex flex-wrap gap-1">
                {openShells.slice(0, 6).map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onOpenShellPreview?.(session.id)}
                    className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    title={session.name}
                  >
                    <Terminal className="size-3" />
                    <span className="truncate">{session.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {visibleSubagents.length > 0 && (
            <>
              <ResourceDivider label="Subagent" />
              <div className="flex flex-wrap gap-1">
                {visibleSubagents.map((subagent) => (
                  <button
                    key={subagent.id}
                    type="button"
                    onClick={() => onOpenSubagentPreview?.(subagent.id)}
                    className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    title={subagentLabel(subagent)}
                  >
                    <Bot className="size-3" />
                    <span className="truncate">{subagentLabel(subagent)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
