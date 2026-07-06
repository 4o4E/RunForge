import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UIMessage } from 'ai';
import { Activity, Bot, CheckCircle2, Circle, Gauge, LoaderCircle, Terminal, XCircle } from 'lucide-react';
import { listShellSessions, listSubagentRuns, type PlanItem, type ShellSession, type StreamStats, type SubagentRun } from '@/api';
import { latestPlanState, latestStreamStats, type UsageSnapshot } from './Conversation';
import { cn } from '@/lib/utils';

export type StatusField = 'run' | 'plan' | 'shell' | 'tokens' | 'cache';

interface Props {
  messages: UIMessage[];
  busy: boolean;
  threadId: string | null;
  className?: string;
  onOpenShellPreview?: (sessionId: string) => void;
  onOpenSubagentPreview?: (subagentId: string) => void;
}

const STORAGE_KEY = 'runforge:right-status-fields';
const LEGACY_STORAGE_KEY = 'my-agent:right-status-fields';
const STREAM_STATS_POINTS = 24;
export const DEFAULT_STATUS_FIELDS: StatusField[] = ['run', 'plan', 'shell', 'tokens', 'cache'];
export const STATUS_FIELD_LABELS: Record<StatusField, string> = {
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

// 状态面板只取最近一条 assistant 的流式统计，避免用户消息或旧 run 抢占展示。
function latestAssistantStreamStats(messages: UIMessage[]) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message.role !== 'assistant') continue;
    const stats = latestStreamStats(message.parts);
    if (stats) return stats;
  }
  return null;
}

function streamStageLabel(stats: StreamStats): string {
  const tool = stats.activeTool?.name ? ` · ${stats.activeTool.name}` : '';
  if (stats.stage === 'llm_waiting') return '等待模型';
  if (stats.stage === 'reasoning') return '思考中';
  if (stats.stage === 'output') return '输出中';
  if (stats.stage === 'tool_call') return `准备调用工具${tool}`;
  if (stats.stage === 'tool_running') return `工具执行中${tool}`;
  if (stats.stage === 'tool_result') return `工具已返回${tool}`;
  if (stats.stage === 'error') return '运行出错';
  return '输出完成';
}

function MiniSparkline({ values }: { values: number[] }) {
  const width = 192;
  const height = 40;
  const samples = values.length ? values.map((value) => Math.max(0, value)) : [0];
  const max = Math.max(1, ...samples);
  const points = samples.map((value, index) => {
    const x = samples.length === 1 ? width : (index / (samples.length - 1)) * width;
    const y = height - (value / max) * (height - 6) - 3;
    return { value, x, y };
  });
  const segmentPath = (index: number) => {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    if (p1.value === 0 && p2.value === 0) return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    return [
      `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`,
      `C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    ].join(' ');
  };

  return (
    <svg className="h-10 w-full overflow-visible" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {points.length === 1 ? (
        <circle
          cx={points[0].x}
          cy={points[0].y}
          r="1.5"
          fill={points[0].value === 0 ? 'hsl(var(--muted-foreground))' : 'currentColor'}
          opacity={points[0].value === 0 ? 0.45 : 1}
        />
      ) : (
        points.slice(0, -1).map((point, index) => {
          const next = points[index + 1];
          const isZero = point.value === 0 && next.value === 0;
          return (
            <path
              key={index}
              d={segmentPath(index)}
              fill="none"
              stroke={isZero ? 'hsl(var(--muted-foreground))' : 'currentColor'}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={isZero ? 0.45 : 1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })
      )}
    </svg>
  );
}

function StreamStatsPanel({ messages, busy }: { messages: UIMessage[]; busy: boolean }) {
  const stats = latestAssistantStreamStats(messages);
  if (!stats) return <StatusRow label="输出速度" value="暂无" />;
  const running = busy && stats.stage !== 'done' && stats.stage !== 'error';
  const charsPerSecond = Math.round(stats.rate.charsPerSecond);
  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex min-h-6 items-center justify-between gap-3 text-xs">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Activity className={cn('size-3.5 shrink-0', running && 'animate-pulse text-foreground')} />
          <span className="truncate">{streamStageLabel(stats)}</span>
        </span>
        <span className="shrink-0 tabular-nums font-medium text-foreground">{charsPerSecond.toLocaleString()} 字/秒</span>
      </div>
      <div className="rounded-lg border bg-background/70 px-2 py-1.5 text-foreground/80">
        <MiniSparkline values={stats.rate.history.slice(-STREAM_STATS_POINTS)} />
      </div>
    </div>
  );
}

export function readStatusFields(): StatusField[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      const fields = parsed.filter((item): item is StatusField => DEFAULT_STATUS_FIELDS.includes(item));
      if (fields.length) return fields;
    }
  } catch {
    // 展示配置损坏时回到默认项。
  }
  return DEFAULT_STATUS_FIELDS;
}

export function writeStatusFields(fields: StatusField[]): StatusField[] {
  const next = fields.length ? fields : DEFAULT_STATUS_FIELDS;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return next;
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
  if (item.status === 'done') return <CheckCircle2 className="size-3.5 text-foreground" />;
  if (item.status === 'doing') return <LoaderCircle className="size-3.5 animate-spin text-foreground" />;
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
  const [fields] = useState<StatusField[]>(readStatusFields);
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

  const show = (field: StatusField) => fields.includes(field);

  return (
    <section className={cn('w-64 rounded-xl border bg-card p-2.5 shadow-sm', className)}>
      <div className="mb-2 flex items-center gap-2">
        <div className={cn('flex size-8 items-center justify-center rounded-md border', busy ? 'text-foreground' : 'text-muted-foreground')}>
          <Gauge className={cn('size-4', busy && 'animate-pulse')} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{busy ? '运行中' : '空闲'}</div>
          <div className="truncate text-xs text-muted-foreground">状态卡片</div>
        </div>
      </div>

      <div className="space-y-1">
        {show('run') && (
          <>
            <StatusRow label="状态" value={busy ? '运行中' : '空闲'} />
            <StatusRow label="消息" value={messageSummary} />
            <StreamStatsPanel messages={messages} busy={busy} />
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
