import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArchiveRestore, Bot, ChevronRight, Gauge, MessageSquare, Moon, Palette, Plus, RefreshCw, Save, Shield, Sun, Trash2, Wifi, Wrench } from 'lucide-react';
import {
  getLlmSettings,
  getLlmSettingsOptions,
  getMcpSettings,
  getMcpSettingsOptions,
  getThread,
  getToolSettings,
  getToolSettingsOptions,
  listThreads,
  pingLlmProvider,
  probeMcpServer,
  probeLlmProviderModels,
  scanShellCommandOptions,
  testLlmProviderChat,
  updateLlmSettings,
  updateMcpSettings,
  updateThread,
  updateToolSettings,
  type AgentEvent,
  type LlmProviderChatTestResult,
  type LlmProviderSettings,
  type LlmSettings,
  type LlmSettingsOptions,
  type McpServerProbeResult,
  type McpServerSettings,
  type McpSettings,
  type McpSettingsOptions,
  type McpToolOption,
  type Thread,
  type ToolSettings,
  type ToolSettingsOptions,
} from '../api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ModelSearchSelect, llmModelRef, llmOptionsFromSettings } from './ModelSearchSelect';
import { useThemeCtx } from '@/theme';
import { useNotifications } from './GlobalNotifications';
import { NavGroup, SectionButton } from '@/components/ui/settings-nav';
import {
  DEFAULT_STATUS_FIELDS,
  STATUS_FIELD_LABELS,
  readStatusFields,
  writeStatusFields,
  type StatusField,
} from './StatusCard';

type SettingsPanel =
  | 'appearance'
  | 'status-card'
  | 'usage-stats'
  | 'archived-threads'
  | 'llm-models'
  | 'mcp-client'
  | 'tools-sandbox'
  | 'tools-access';

interface UsagePoint {
  at: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

interface UsageStats {
  threads: number;
  runs: number;
  points: UsagePoint[];
  totalInput: number;
  totalOutput: number;
  totalCached: number;
  totalTokens: number;
  peakTokens: number;
  averageTokens: number;
  daily: UsageDay[];
}

interface UsageDay {
  date: string;
  totalTokens: number;
  future: boolean;
}

interface LlmChatDialogState {
  providerIndex: number;
  model: string;
  input: string;
  result?: LlmProviderChatTestResult;
}

function listToText(items: string[]): string {
  return items.join('\n');
}

function textToList(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pathToList(value: string): string[] {
  return value
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
}

function listToPath(items: string[]): string {
  return items.map((item) => item.trim()).filter(Boolean).join(':');
}

function toggleListValue(items: string[], value: string, checked: boolean): string[] {
  const next = new Set(items);
  if (checked) next.add(value);
  else next.delete(value);
  return [...next].sort();
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SettingsPanelShell({
  actions,
  children,
  contentClassName,
  description,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  description: string;
  title: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto pr-1', contentClassName)}>{children}</div>
    </div>
  );
}

function PathListField({
  disabled,
  label,
  value,
  onChange,
}: {
  disabled: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [rows, setRows] = useState<string[]>(() => pathToList(value));

  useEffect(() => {
    setRows(pathToList(value));
  }, [value]);

  function updateRows(nextRows: string[]) {
    setRows(nextRows);
    onChange(listToPath(nextRows));
  }

  const visibleRows = rows.length ? rows : [''];

  return (
    <div className="grid gap-2 text-sm font-medium">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setRows([...rows, ''])}>
          <Plus className="h-4 w-4" />
          添加路径
        </Button>
      </div>
      <ScrollArea className="min-w-0 rounded-md border" viewportClassName="max-h-48 !h-auto">
        <div className="grid gap-2 p-2">
          {visibleRows.map((path, index) => (
            <div key={`path-${index}`} className="grid min-w-0 grid-cols-[minmax(0,1fr),auto] gap-2">
              <Input
                value={path}
                disabled={disabled}
                placeholder="/usr/local/bin"
                onChange={(event) => {
                  const nextRows = [...visibleRows];
                  nextRows[index] = event.target.value;
                  updateRows(nextRows);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={disabled}
                onClick={() => updateRows(visibleRows.filter((_, rowIndex) => rowIndex !== index))}
                aria-label="删除路径"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function OptionList({
  empty,
  fill = false,
  items,
  selected,
  renderMeta,
  onToggle,
}: {
  empty: string;
  fill?: boolean;
  items: Array<{ name: string; description?: string }>;
  selected: (name: string) => boolean;
  renderMeta?: (item: { name: string; description?: string }) => ReactNode;
  onToggle: (name: string, checked: boolean) => void;
}) {
  const optionId = useId();

  return (
    <ScrollArea className={cn('min-w-0', fill && 'min-h-0 flex-1')} viewportClassName={fill ? 'h-full' : 'max-h-64 !h-auto'}>
      <div className={cn('grid min-w-0 divide-y rounded-md border', fill && 'min-h-full content-start')}>
        {items.length === 0 && <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{empty}</div>}
        {items.map((item, index) => {
          const id = `${optionId}-${index}`;
          const checked = selected(item.name);
          return (
            <div
              key={item.name}
              className="grid min-w-0 cursor-pointer grid-cols-[auto,minmax(0,1fr)] items-start gap-3 px-3 py-2 text-sm transition-colors hover:bg-accent/60"
              onClick={() => onToggle(item.name, !checked)}
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(checked) => onToggle(item.name, checked === true)}
                onClick={(event) => event.stopPropagation()}
                className="mt-0.5"
                aria-label={item.name}
              />
              <div className="min-w-0 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 max-w-full break-all font-medium leading-5 [overflow-wrap:anywhere]">
                    {item.name}
                  </span>
                  {renderMeta && <span className="shrink-0">{renderMeta(item)}</span>}
                </div>
                {item.description && (
                  <p className="m-0 min-w-0 max-w-full whitespace-normal break-all text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

const LLM_PROVIDER_OPTIONS: Array<{ value: LlmProviderSettings['provider']; label: string }> = [
  { value: 'aisdk', label: 'AI SDK' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-chat', label: 'OpenAI Chat' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'mock', label: 'Mock' },
];

const AI_SDK_FLAVOR_OPTIONS: Array<{ value: LlmProviderSettings['aisdkFlavor']; label: string }> = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
];

function keyValueRowsToText(rows: Array<{ name: string; value: string }>): string {
  return rows.map((row) => `${row.name}=${row.value}`).join('\n');
}

function textToKeyValueRows(text: string): Array<{ name: string; value: string }> {
  return text
    .split('\n')
    .map((line) => {
      const sep = line.indexOf('=');
      const name = (sep >= 0 ? line.slice(0, sep) : line).trim();
      const value = sep >= 0 ? line.slice(sep + 1) : '';
      return name ? { name, value } : null;
    })
    .filter((row): row is { name: string; value: string } => Boolean(row));
}

function newMcpServer(): McpServerSettings {
  return {
    id: `mcp-${Date.now()}`,
    label: 'MCP Server',
    enabled: false,
    url: '',
    bearerToken: '',
    headers: [],
    allowedTools: [],
    timeoutMs: 60000,
    maxOutput: 40000,
  };
}

function llmModelPrefix(model: string): string {
  const separators = ['-', ':', '/', '_', '.'];
  const indexes = separators.map((item) => model.indexOf(item)).filter((index) => index > 0);
  const end = indexes.length ? Math.min(...indexes) : model.length;
  return model.slice(0, end) || '其他';
}

function llmProviderCandidates(provider: LlmProviderSettings): string[] {
  return [...new Set([...provider.discoveredModels, ...provider.models, provider.defaultModel].map((item) => item.trim()).filter(Boolean))].sort();
}

function groupLlmModels(models: string[]): Array<{ prefix: string; models: string[] }> {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const prefix = llmModelPrefix(model);
    groups.set(prefix, [...(groups.get(prefix) ?? []), model]);
  }
  return [...groups.entries()]
    .map(([prefix, rows]) => ({ prefix, models: rows.sort() }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function defaultLlmProvider(index: number): LlmProviderSettings {
  return {
    id: `provider-${index + 1}`,
    label: `供应商 ${index + 1}`,
    provider: 'aisdk',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    discoveredModels: ['gpt-4o-mini'],
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
    maxTokens: 4096,
    timeoutMs: 120000,
    retries: 2,
    stream: true,
    aisdkFlavor: 'openai-compatible',
    reasoningTag: 'think',
  };
}

let llmProviderUiKeySeq = 0;

function createLlmProviderUiKey(): string {
  llmProviderUiKeySeq += 1;
  return `llm-provider-${llmProviderUiKeySeq}`;
}

function reconcileLlmProviderUiKeys(keys: string[], count: number): string[] {
  if (keys.length === count) return keys;
  if (keys.length > count) return keys.slice(0, count);
  return [...keys, ...Array.from({ length: count - keys.length }, () => createLlmProviderUiKey())];
}

export function shortTime(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usagePointFromEvent(event: AgentEvent, at: string): UsagePoint | null {
  if (event.type !== 'usage_update') return null;
  const inputTokens = numberField(event.inputTokens);
  const outputTokens = numberField(event.outputTokens);
  const cachedInputTokens = numberField(event.cachedInputTokens);
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0 && cachedInputTokens <= 0) return null;
  return { at, inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

function buildUsageStats(details: Awaited<ReturnType<typeof getThread>>[]): UsageStats {
  const points: UsagePoint[] = [];
  let runs = 0;
  for (const detail of details) {
    runs += detail.runs.length;
    for (const run of detail.runs) {
      for (const event of run.events) {
        const point = usagePointFromEvent(event, run.updated_at || run.created_at);
        if (point) points.push(point);
      }
    }
  }
  const dailyMap = new Map<string, number>();
  for (const point of points) {
    const date = new Date(point.at);
    if (!Number.isNaN(date.getTime())) {
      const key = localDateKey(date);
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + point.totalTokens);
    }
  }
  const today = startOfLocalDay(new Date());
  const end = new Date(today);
  end.setDate(today.getDate() + (6 - today.getDay()));
  const start = new Date(end);
  start.setDate(end.getDate() - 83);
  const daily = Array.from({ length: 84 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = localDateKey(date);
    return { date: key, totalTokens: dailyMap.get(key) ?? 0, future: date > today };
  });
  const totalInput = points.reduce((sum, point) => sum + point.inputTokens, 0);
  const totalOutput = points.reduce((sum, point) => sum + point.outputTokens, 0);
  const totalCached = points.reduce((sum, point) => sum + point.cachedInputTokens, 0);
  const totalTokens = totalInput + totalOutput;
  const peakTokens = points.reduce((peak, point) => Math.max(peak, point.totalTokens), 0);
  const averageTokens = points.length ? Math.round(totalTokens / points.length) : 0;
  return {
    threads: details.length,
    runs,
    points,
    totalInput,
    totalOutput,
    totalCached,
    totalTokens,
    peakTokens,
    averageTokens,
    daily,
  };
}

function formatMetric(value: number): string {
  return value.toLocaleString();
}

function AppearanceSettingsPanel() {
  const { theme, setTheme } = useThemeCtx();

  return (
    <SettingsPanelShell title="外观" description="浅色、深色和界面显示偏好" contentClassName="grid content-start gap-4">
      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>颜色模式</CardTitle>
          <CardDescription>设置会立即应用，并保存在当前浏览器中</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setTheme('light')}
            className={cn(
              'flex min-h-24 items-center gap-3 rounded-md border p-4 text-left transition-colors hover:bg-accent/60',
              theme === 'light' && 'border-primary bg-primary/5 ring-1 ring-primary/30',
            )}
          >
            <Sun className="size-5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">浅色模式</span>
              <span className="mt-1 block text-xs text-muted-foreground">适合明亮环境，页面对比更轻。</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTheme('dark')}
            className={cn(
              'flex min-h-24 items-center gap-3 rounded-md border p-4 text-left transition-colors hover:bg-accent/60',
              theme === 'dark' && 'border-primary bg-primary/5 ring-1 ring-primary/30',
            )}
          >
            <Moon className="size-5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">深色模式</span>
              <span className="mt-1 block text-xs text-muted-foreground">适合低光环境，降低大面积亮度。</span>
            </span>
          </button>
        </CardContent>
      </Card>
    </SettingsPanelShell>
  );
}

function StatusCardSettingsPanel() {
  const [fields, setFields] = useState<StatusField[]>(readStatusFields);

  const toggleField = (field: StatusField) => {
    setFields((current) => {
      const next = current.includes(field) ? current.filter((item) => item !== field) : [...current, field];
      return writeStatusFields(next);
    });
  };

  return (
    <SettingsPanelShell title="状态卡片" description="控制聊天页状态卡片展示哪些运行信息" contentClassName="grid content-start gap-4">
      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>状态卡片字段</CardTitle>
          <CardDescription>至少保留一项；全部取消时会自动恢复默认字段</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {DEFAULT_STATUS_FIELDS.map((field) => (
            <label
              key={field}
              className="flex min-h-12 items-center gap-3 rounded-md border p-3 text-sm transition-colors hover:bg-accent/60"
            >
              <Checkbox checked={fields.includes(field)} onCheckedChange={() => toggleField(field)} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{STATUS_FIELD_LABELS[field]}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {field === 'tokens'
                    ? '输入、输出 token'
                    : field === 'cache'
                      ? '缓存命中 token 占比'
                      : field === 'shell'
                        ? 'Shell 和子任务资源'
                        : field === 'plan'
                          ? '当前计划进度'
                          : '运行状态和消息数量'}
                </span>
              </span>
            </label>
          ))}
        </CardContent>
      </Card>
    </SettingsPanelShell>
  );
}

function UsageStatsSettingsPanel() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const refreshStats = () => {
    setLoading(true);
    setMessage('');
    Promise.all([listThreads(), listThreads({ archived: true })])
      .then(async ([activeThreads, archivedThreads]) => {
        const threads = [...activeThreads, ...archivedThreads];
        const details = await Promise.all(threads.map((thread) => getThread(thread.id)));
        setStats(buildUsageStats(details));
      })
      .catch((err) => setMessage(`读取用量失败：${(err as Error).message}`))
      .finally(() => setLoading(false));
  };

  useEffect(refreshStats, []);

  const dailyUsage = stats?.daily ?? Array.from({ length: 84 }, () => ({ date: '', totalTokens: 0, future: false }));
  const heatmapWeeks = Array.from({ length: 12 }, (_, week) => dailyUsage.slice(week * 7, week * 7 + 7));
  const maxDaily = Math.max(1, ...dailyUsage.map((day) => day.totalTokens));

  return (
    <SettingsPanelShell
      title="用量统计"
      description="按历史 run 事件统计 token 消耗、峰值、平均值和日热力图"
      contentClassName="grid content-start gap-4"
      actions={
        <>
          {message && <span className="max-w-md truncate text-sm text-muted-foreground">{message}</span>}
          <Button variant="outline" onClick={refreshStats} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            {loading ? '刷新中' : '刷新'}
          </Button>
        </>
      }
    >
      <div className="grid items-start gap-3 md:grid-cols-3 xl:grid-cols-4">
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>总消耗</CardDescription>
            <CardTitle>{formatMetric(stats?.totalTokens ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            输入 {formatMetric(stats?.totalInput ?? 0)} · 输出 {formatMetric(stats?.totalOutput ?? 0)}
          </CardContent>
        </Card>
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>峰值</CardDescription>
            <CardTitle>{formatMetric(stats?.peakTokens ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">单次 usage_update 的最高 token 消耗</CardContent>
        </Card>
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>平均</CardDescription>
            <CardTitle>{formatMetric(stats?.averageTokens ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">按 usage_update 条数平均</CardContent>
        </Card>
        <Card className="rounded-lg shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription>缓存命中</CardDescription>
            <CardTitle>{formatMetric(stats?.totalCached ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {formatMetric(stats?.threads ?? 0)} 个会话 · {formatMetric(stats?.runs ?? 0)} 个 run
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>日热力图</CardTitle>
          <CardDescription>最近 12 周每日 token 消耗，颜色越深表示当天消耗越高</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 overflow-x-auto">
          <div className="grid w-max grid-cols-[auto_repeat(12,0.875rem)] gap-1">
            <div />
            {heatmapWeeks.map((week, index) => (
              <div key={`week-${index}`} className="h-3 text-[10px] tabular-nums text-muted-foreground">
                {index % 3 === 0 ? week[0]?.date.slice(5) : ''}
              </div>
            ))}
            {['日', '一', '二', '三', '四', '五', '六'].map((weekday, row) => (
              <Fragment key={`weekday-${weekday}`}>
                <div className="flex h-3 items-center pr-1 text-[10px] text-muted-foreground">
                  {row % 2 === 1 ? weekday : ''}
                </div>
                {heatmapWeeks.map((week, column) => {
                  const day = week[row] ?? { date: '', totalTokens: 0, future: false };
                  const ratio = day.totalTokens / maxDaily;
                  return (
                    <div
                      key={`${day.date || column}-${row}`}
                      className={cn('size-3 rounded-[2px] border border-border/60', day.future && 'opacity-35')}
                      style={{
                        backgroundColor:
                          day.future
                            ? 'transparent'
                            : day.totalTokens > 0
                              ? `hsl(var(--primary) / ${Math.max(0.18, ratio).toFixed(2)})`
                              : 'hsl(var(--muted))',
                      }}
                      title={day.date ? `${day.date} · ${day.future ? '未到日期' : `${formatMetric(day.totalTokens)} token`}` : '暂无数据'}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>少</span>
            {[0.15, 0.35, 0.6, 0.85, 1].map((opacity) => (
              <span
                key={opacity}
                className="size-3 rounded-[2px] border border-border/60"
                style={{ backgroundColor: `hsl(var(--primary) / ${opacity})` }}
              />
            ))}
            <span>多</span>
          </div>
        </CardContent>
      </Card>
    </SettingsPanelShell>
  );
}

function threadTitle(thread: Thread): string {
  return thread.title?.trim() || thread.fallback_title?.trim() || `会话 ${thread.id.slice(0, 8)}`;
}

function ArchivedThreadsSettingsPanel({ onThreadsChanged }: { onThreadsChanged?: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const refreshArchivedThreads = () => {
    setLoading(true);
    setMessage('');
    listThreads({ archived: true })
      .then(setThreads)
      .catch((err) => setMessage(`读取已归档会话失败：${(err as Error).message}`))
      .finally(() => setLoading(false));
  };

  useEffect(refreshArchivedThreads, []);

  async function restoreThread(id: string) {
    setRestoringId(id);
    setMessage('');
    try {
      await updateThread(id, { archived: false });
      setThreads((current) => current.filter((thread) => thread.id !== id));
      onThreadsChanged?.();
    } catch (err) {
      setMessage(`取消归档失败：${(err as Error).message}`);
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <SettingsPanelShell
      title="已归档"
      description="归档会话会从左侧列表隐藏，但保留历史运行记录"
      contentClassName="grid content-start gap-3"
      actions={
        <>
          {message && <span className="max-w-md truncate text-sm text-muted-foreground">{message}</span>}
          <Button variant="outline" onClick={refreshArchivedThreads} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            {loading ? '刷新中' : '刷新'}
          </Button>
        </>
      }
    >
      {threads.length === 0 && (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          暂无已归档会话
        </div>
      )}
      {threads.map((thread) => (
        <Card key={thread.id} className="rounded-lg shadow-sm">
          <CardContent className="flex min-w-0 items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{threadTitle(thread)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                归档：{shortTime(thread.archived_at)} · 更新：{shortTime(thread.updated_at)}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => void restoreThread(thread.id)} disabled={restoringId === thread.id}>
              {restoringId === thread.id ? <Spinner className="h-4 w-4" /> : <ArchiveRestore className="h-4 w-4" />}
              取消归档
            </Button>
          </CardContent>
        </Card>
      ))}
    </SettingsPanelShell>
  );
}

function ToolsSettingsPanel({
  onWorkspaceChanged,
  section,
}: {
  onWorkspaceChanged: () => void;
  section: 'access' | 'sandbox-shell';
}) {
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [options, setOptions] = useState<ToolSettingsOptions | null>(null);
  const [shellDenyText, setShellDenyText] = useState('');
  const [shellCommandQuery, setShellCommandQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let canceled = false;
    Promise.all([getToolSettings(), getToolSettingsOptions()])
      .then(([data, nextOptions]) => {
        if (canceled) return;
        setSettings(data);
        setOptions(nextOptions);
        setShellDenyText(listToText(data.shellDeny));
      })
      .catch((err) => {
        if (!canceled) setMessage(`读取配置失败：${(err as Error).message}`);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const prepared = useMemo<ToolSettings | null>(() => {
    if (!settings) return null;
    return {
      ...settings,
      deny: settings.toolAccessMode === 'deny' ? settings.deny : [],
      allow: settings.toolAccessMode === 'allow' ? settings.allow : [],
      shellDeny: textToList(shellDenyText),
      maxOutput: Math.max(1000, Math.floor(Number(settings.maxOutput) || 1000)),
    };
  }, [settings, shellDenyText]);

  const toolOptions = options?.tools ?? [];
  const shellCommandOptions = options?.shellCommands ?? [];
  const filteredShellCommandOptions = useMemo(() => {
    const query = shellCommandQuery.trim().toLowerCase();
    if (!query) return shellCommandOptions;
    return shellCommandOptions.filter((command) => {
      const path = command.path ?? '';
      return command.name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
    });
  }, [shellCommandOptions, shellCommandQuery]);
  const allToolNames = useMemo(() => toolOptions.map((tool) => tool.name), [toolOptions]);
  const selectedToolSet = useMemo(
    () => new Set(settings?.toolAccessMode === 'allow' ? settings.allow : settings?.deny ?? []),
    [settings?.allow, settings?.deny, settings?.toolAccessMode],
  );
  const shellCommandSet = useMemo(() => new Set(settings?.shellAllowCommands ?? []), [settings?.shellAllowCommands]);

  function setToolMode(mode: ToolSettings['toolAccessMode']) {
    if (!settings) return;
    if (mode === settings.toolAccessMode) return;
    if (mode === 'allow') {
      const denied = new Set(settings.deny);
      setSettings({ ...settings, toolAccessMode: 'allow', allow: allToolNames.filter((name) => !denied.has(name)), deny: [] });
      return;
    }
    const allowed = new Set(settings.allow);
    setSettings({ ...settings, toolAccessMode: 'deny', allow: [], deny: allToolNames.filter((name) => !allowed.has(name)) });
  }

  function setToolSelected(name: string, checked: boolean) {
    if (!settings) return;
    if (settings.toolAccessMode === 'allow') {
      setSettings({ ...settings, allow: toggleListValue(settings.allow, name, checked), deny: [] });
      return;
    }
    setSettings({ ...settings, allow: [], deny: toggleListValue(settings.deny, name, checked) });
  }

  function setAllTools(checked: boolean) {
    if (!settings) return;
    if (settings.toolAccessMode === 'allow') {
      setSettings({ ...settings, allow: checked ? allToolNames : [], deny: [] });
      return;
    }
    setSettings({ ...settings, allow: [], deny: checked ? allToolNames : [] });
  }

  function resetTools() {
    if (!settings) return;
    setSettings({ ...settings, toolAccessMode: 'deny', allow: [], deny: [] });
  }

  function setShellCommand(name: string, checked: boolean) {
    if (!settings) return;
    setSettings({ ...settings, shellAllowCommands: toggleListValue(settings.shellAllowCommands, name, checked) });
  }

  async function scanShellCommands() {
    if (!settings || !options) return;
    setScanning(true);
    setMessage('');
    try {
      const result = await scanShellCommandOptions({
        shellPathMode: settings.shellPathMode,
        shellPath: settings.shellPath,
        include: settings.shellAllowCommands,
      });
      setOptions({ ...options, shellCommands: result.shellCommands });
      setMessage(`已扫描 PATH：发现 ${result.shellCommands.length} 个候选指令`);
    } catch (err) {
      setMessage(`扫描失败：${(err as Error).message}`);
    } finally {
      setScanning(false);
    }
  }

  async function save() {
    if (!prepared) return;
    setSaving(true);
    setMessage('');
    try {
      const next = await updateToolSettings(prepared);
      setSettings(next);
      setOptions(await getToolSettingsOptions());
      setShellDenyText(listToText(next.shellDeny));
      onWorkspaceChanged();
      setMessage('已保存');
    } catch (err) {
      setMessage(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !options) {
    return <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">正在读取配置...</div>;
  }
  const accessSection = section === 'access';

  return (
    <SettingsPanelShell
      title={accessSection ? '工具准入' : 'Shell / 沙箱'}
      description={accessSection ? '选择可调用或拒绝调用的工具' : 'Shell 执行方式、bwrap 后端、PATH 和可见指令'}
      contentClassName={accessSection ? 'flex flex-col gap-4' : 'grid content-start gap-4'}
      actions={
        <>
          {message && <span className="text-sm text-muted-foreground">{message}</span>}
          <Button onClick={() => void save()} disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? '保存中' : '保存'}
          </Button>
        </>
      }
    >

      {accessSection ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm">
              <span className={cn(settings.toolAccessMode === 'deny' ? 'text-foreground' : 'text-muted-foreground')}>黑名单</span>
              <Switch
                checked={settings.toolAccessMode === 'allow'}
                onCheckedChange={(checked) => setToolMode(checked ? 'allow' : 'deny')}
              />
              <span className={cn(settings.toolAccessMode === 'allow' ? 'text-foreground' : 'text-muted-foreground')}>白名单</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setAllTools(true)}>全选</Button>
              <Button variant="outline" size="sm" onClick={() => setAllTools(false)}>全不选</Button>
              <Button variant="outline" size="sm" onClick={resetTools}>重置</Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="text-sm font-medium">{settings.toolAccessMode === 'allow' ? '白名单工具' : '黑名单工具'}</div>
            <OptionList
              fill
              empty="后端没有下发工具候选"
              items={toolOptions}
              selected={(name) => selectedToolSet.has(name)}
              onToggle={setToolSelected}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          <div>
            <Field label="工作区根目录">
              <Input value={settings.workspaceRoot} onChange={(event) => setSettings({ ...settings, workspaceRoot: event.target.value })} />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Shell 执行方式">
              <Select
                value={settings.shellUseHostPath ? 'host' : 'sandbox'}
                onValueChange={(value) => setSettings({ ...settings, shellUseHostPath: value === 'host' })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="host">宿主执行</SelectItem>
                  <SelectItem value="sandbox">沙箱投射</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Shell 策略模式">
              <Select value={settings.sandbox} onValueChange={(value) => setSettings({ ...settings, sandbox: value as ToolSettings['sandbox'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">off</SelectItem>
                  <SelectItem value="enforce">enforce</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Shell 沙箱后端">
              <Select
                value={settings.sandboxBackend}
                onValueChange={(value) => setSettings({ ...settings, sandboxBackend: value as ToolSettings['sandboxBackend'] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="none">none</SelectItem>
                  <SelectItem value="bwrap">bwrap</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="网络">
              <Select value={settings.network} onValueChange={(value) => setSettings({ ...settings, network: value as ToolSettings['network'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="disabled">disabled</SelectItem>
                  <SelectItem value="enabled">enabled</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="单条工具结果上限">
              <Input
                type="number"
                min={1000}
                value={settings.maxOutput}
                onChange={(event) => setSettings({ ...settings, maxOutput: Number(event.target.value) })}
              />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-4 content-start">
              <div className="grid gap-2 text-sm font-medium">
                <span>PATH 来源</span>
                <div className="inline-flex h-10 w-fit items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm">
                  <span className={cn(settings.shellPathMode === 'system' ? 'text-foreground' : 'text-muted-foreground')}>系统</span>
                  <Switch
                    checked={settings.shellPathMode === 'custom'}
                    onCheckedChange={(checked) => setSettings({ ...settings, shellPathMode: checked ? 'custom' : 'system' })}
                  />
                  <span className={cn(settings.shellPathMode === 'custom' ? 'text-foreground' : 'text-muted-foreground')}>手动</span>
                </div>
              </div>
              <PathListField
                label="PATH"
                value={settings.shellPathMode === 'system' ? options.systemPath : settings.shellPath}
                disabled={settings.shellPathMode === 'system'}
                onChange={(value) => setSettings({ ...settings, shellPath: value })}
              />
            </div>
            <Field label="Shell deny 正则">
              <Textarea rows={10} value={shellDenyText} onChange={(event) => setShellDenyText(event.target.value)} />
            </Field>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium">可见指令</div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const next = new Set(settings.shellAllowCommands);
                    for (const command of filteredShellCommandOptions) next.add(command.name);
                    setSettings({ ...settings, shellAllowCommands: [...next].sort() });
                  }}
                >
                  全选当前
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const visible = new Set(filteredShellCommandOptions.map((command) => command.name));
                    setSettings({ ...settings, shellAllowCommands: settings.shellAllowCommands.filter((name) => !visible.has(name)) });
                  }}
                >
                  清空当前
                </Button>
                <Button variant="outline" size="sm" onClick={() => void scanShellCommands()} disabled={scanning}>
                  <RefreshCw className={cn('h-4 w-4', scanning && 'animate-spin')} />
                  {scanning ? '扫描中' : '扫描'}
                </Button>
              </div>
            </div>
            <Input
              value={shellCommandQuery}
              onChange={(event) => setShellCommandQuery(event.target.value)}
              placeholder={`搜索命令或路径，当前 ${filteredShellCommandOptions.length} / ${shellCommandOptions.length}`}
            />
            <OptionList
              empty={shellCommandQuery.trim() ? '没有匹配的可见指令' : '后端没有下发可见指令候选'}
              items={filteredShellCommandOptions.map((command) => ({
                name: command.name,
                description: command.path ?? '当前 PATH 未找到，保存后也不会被 bwrap 投射',
              }))}
              selected={(name) => shellCommandSet.has(name)}
              renderMeta={(item) => {
                const command = shellCommandOptions.find((option) => option.name === item.name);
                return command?.available ? null : <Badge variant="outline">未找到</Badge>;
              }}
              onToggle={setShellCommand}
            />
          </div>
        </div>
      )}
    </SettingsPanelShell>
  );
}

function McpSettingsPanel() {
  const { notify } = useNotifications();
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [options, setOptions] = useState<McpSettingsOptions | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, McpServerProbeResult>>({});
  const [message, setMessage] = useState('');

  async function reload() {
    const [nextSettings, nextOptions] = await Promise.all([getMcpSettings(), getMcpSettingsOptions()]);
    setSettings(nextSettings);
    setOptions(nextOptions);
  }

  useEffect(() => {
    reload().catch((err) => setMessage((err as Error).message));
  }, []);

  function updateServer(index: number, patch: Partial<McpServerSettings>) {
    if (!settings) return;
    const servers = settings.servers.map((server, rowIndex) => rowIndex === index ? { ...server, ...patch } : server);
    setSettings({ servers });
  }

  function removeServer(index: number) {
    if (!settings) return;
    setSettings({ servers: settings.servers.filter((_, rowIndex) => rowIndex !== index) });
  }

  function toolsForServer(server: McpServerSettings): McpToolOption[] {
    const probed = probeResults[server.id]?.tools;
    if (probed) return probed;
    return (options?.tools ?? []).filter((tool) => tool.serverId === server.id);
  }

  function setToolAllowed(index: number, toolName: string, checked: boolean) {
    if (!settings) return;
    const server = settings.servers[index];
    const next = new Set(server.allowedTools);
    if (checked) next.add(toolName);
    else next.delete(toolName);
    updateServer(index, { allowedTools: [...next].sort() });
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setMessage('');
    try {
      const next = await updateMcpSettings(settings);
      setSettings(next);
      setOptions(await getMcpSettingsOptions());
      notify({ variant: 'success', title: 'MCP 配置已保存' });
    } catch (err) {
      const text = (err as Error).message;
      setMessage(text);
      notify({ variant: 'error', title: 'MCP 配置保存失败', description: text });
    } finally {
      setSaving(false);
    }
  }

  async function probe(index: number) {
    if (!settings) return;
    const server = settings.servers[index];
    setProbing(server.id);
    try {
      const result = await probeMcpServer(server);
      setProbeResults((prev) => ({ ...prev, [server.id]: result }));
      notify({ variant: result.ok ? 'success' : 'error', title: result.ok ? 'MCP 连接成功' : 'MCP 连接失败', description: result.message });
    } catch (err) {
      const result: McpServerProbeResult = { ok: false, message: (err as Error).message, toolCount: 0, tools: [] };
      setProbeResults((prev) => ({ ...prev, [server.id]: result }));
      notify({ variant: 'error', title: 'MCP 连接失败', description: result.message });
    } finally {
      setProbing(null);
    }
  }

  if (!settings || !options) {
    return <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">正在读取配置...</div>;
  }

  return (
    <SettingsPanelShell
      title="MCP Client"
      description="连接外部 MCP Server，并选择允许模型调用的远端工具"
      contentClassName="grid content-start gap-4"
      actions={
        <>
          {message && <span className="text-sm text-muted-foreground">{message}</span>}
          <Button variant="outline" onClick={() => setSettings({ servers: [...settings.servers, newMcpServer()] })}>
            <Plus className="h-4 w-4" />
            添加
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? '保存中' : '保存'}
          </Button>
        </>
      }
    >
      {settings.servers.length === 0 && (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">还没有 MCP server。</div>
      )}
      {settings.servers.map((server, index) => {
        const serverTools = toolsForServer(server);
        const allowed = new Set(server.allowedTools);
        return (
          <Card key={index} className="rounded-lg shadow-sm">
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-[minmax(0,12rem),minmax(0,1fr)]">
                  <Field label="ID">
                    <Input value={server.id} onChange={(event) => updateServer(index, { id: event.target.value })} />
                  </Field>
                  <Field label="名称">
                    <Input value={server.label} onChange={(event) => updateServer(index, { label: event.target.value })} />
                  </Field>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant={server.enabled ? 'default' : 'outline'}>{server.enabled ? '已启用' : '未启用'}</Badge>
                  <Switch checked={server.enabled} onCheckedChange={(checked) => updateServer(index, { enabled: checked })} />
                  <Button variant="outline" size="icon" onClick={() => removeServer(index)} aria-label="删除 MCP server">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="超时 ms">
                  <Input type="number" min={1000} value={server.timeoutMs} onChange={(event) => updateServer(index, { timeoutMs: Number(event.target.value) })} />
                </Field>
                <Field label="结果上限">
                  <Input type="number" min={1000} value={server.maxOutput} onChange={(event) => updateServer(index, { maxOutput: Number(event.target.value) })} />
                </Field>
                <div className="flex items-end">
                  <Button variant="outline" className="w-full" onClick={() => void probe(index)} disabled={probing === server.id}>
                    <RefreshCw className={cn('h-4 w-4', probing === server.id && 'animate-spin')} />
                    {probing === server.id ? '测试中' : '测试'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="URL">
                  <Input value={server.url} onChange={(event) => updateServer(index, { url: event.target.value })} placeholder="https://example.com/mcp" />
                </Field>
                <Field label="Bearer Token">
                  <Input type="password" value={server.bearerToken} onChange={(event) => updateServer(index, { bearerToken: event.target.value })} />
                </Field>
                <div className="md:col-span-2">
                  <Field label="Headers">
                    <Textarea rows={4} value={keyValueRowsToText(server.headers)} onChange={(event) => updateServer(index, { headers: textToKeyValueRows(event.target.value) })} />
                  </Field>
                </div>
              </div>
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">允许工具</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-xs text-muted-foreground">已允许 {server.allowedTools.length} / 已发现 {serverTools.length}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => updateServer(index, { allowedTools: serverTools.map((tool) => tool.name).sort() })}
                      disabled={serverTools.length === 0}
                    >
                      全选
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => updateServer(index, { allowedTools: [] })}
                      disabled={server.allowedTools.length === 0}
                    >
                      清空
                    </Button>
                  </div>
                </div>
                <OptionList
                  empty="还没有发现工具，请先测试连接"
                  items={serverTools.map((tool) => ({ name: tool.name, description: tool.description }))}
                  selected={(name) => allowed.has(name)}
                  renderMeta={(item) => {
                    const tool = serverTools.find((candidate) => candidate.name === item.name);
                    return tool ? <Badge variant="outline">{tool.mappedName}</Badge> : null;
                  }}
                  onToggle={(name, checked) => setToolAllowed(index, name, checked)}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </SettingsPanelShell>
  );
}

function LlmSettingsPanel() {
  const { notify } = useNotifications();
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [options, setOptions] = useState<LlmSettingsOptions | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [providerBusy, setProviderBusy] = useState<Record<string, string>>({});
  const [customModelDrafts, setCustomModelDrafts] = useState<Record<string, string>>({});
  const [chatDialog, setChatDialog] = useState<LlmChatDialogState | null>(null);
  const [chatTesting, setChatTesting] = useState(false);
  const [modelGroupOpen, setModelGroupOpen] = useState<Record<string, boolean>>({});
  const [providerOpen, setProviderOpen] = useState<Record<string, boolean>>({});
  const [providerUiKeys, setProviderUiKeys] = useState<string[]>([]);

  useEffect(() => {
    let canceled = false;
    Promise.all([getLlmSettings(), getLlmSettingsOptions()])
      .then(([data, nextOptions]) => {
        if (canceled) return;
        setProviderUiKeys(reconcileLlmProviderUiKeys([], data.providers.length));
        setSettings(data);
        setOptions(nextOptions);
      })
      .catch((err) => {
        if (!canceled) setMessage(`读取配置失败：${(err as Error).message}`);
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    setProviderUiKeys((current) => reconcileLlmProviderUiKeys(current, settings.providers.length));
  }, [settings?.providers.length]);

  const modelOptions = useMemo(() => {
    if (settings) return llmOptionsFromSettings(settings);
    return options?.models ?? [];
  }, [options?.models, settings]);

  function updateProvider(index: number, patch: Partial<LlmProviderSettings>) {
    if (!settings) return;
    const providers = settings.providers.map((provider, providerIndex) => {
      if (providerIndex !== index) return provider;
      const next = { ...provider, ...patch };
      if (patch.models && !next.models.includes(next.defaultModel)) next.defaultModel = next.models[0] ?? '';
      return next;
    });
    const nextOptions = llmOptionsFromSettings({ ...settings, providers });
    const defaultModelRef = nextOptions.some((option) => option.ref === settings.defaultModelRef)
      ? settings.defaultModelRef
      : nextOptions[0]?.ref ?? '';
    setSettings({ ...settings, providers, defaultModelRef });
  }

  function providerKey(index: number): string {
    return providerUiKeys[index] ?? `llm-provider-pending-${index}`;
  }

  function modelGroupKey(index: number, prefix: string): string {
    return `${providerKey(index)}:${prefix}`;
  }

  function isModelGroupOpen(index: number, prefix: string): boolean {
    return modelGroupOpen[modelGroupKey(index, prefix)] ?? true;
  }

  function setModelGroupsOpen(index: number, prefixes: string[], open: boolean) {
    setModelGroupOpen((current) => {
      const next = { ...current };
      for (const prefix of prefixes) next[modelGroupKey(index, prefix)] = open;
      return next;
    });
  }

  function setProviderBusyLabel(index: number, label: string | null) {
    const key = providerKey(index);
    setProviderBusy((current) => {
      const next = { ...current };
      if (label) next[key] = label;
      else delete next[key];
      return next;
    });
  }

  function setModelEnabled(index: number, model: string, checked: boolean) {
    if (!settings) return;
    const provider = settings.providers[index];
    const models = toggleListValue(provider.models, model, checked);
    updateProvider(index, {
      models,
      defaultModel: models.includes(provider.defaultModel) ? provider.defaultModel : models[0] ?? '',
      discoveredModels: [...new Set([...provider.discoveredModels, model])].sort(),
    });
  }

  function setPrefixEnabled(index: number, modelsInPrefix: string[], checked: boolean) {
    if (!settings) return;
    const provider = settings.providers[index];
    const next = new Set(provider.models);
    for (const model of modelsInPrefix) {
      if (checked) next.add(model);
      else next.delete(model);
    }
    const models = [...next].sort();
    updateProvider(index, {
      models,
      defaultModel: models.includes(provider.defaultModel) ? provider.defaultModel : models[0] ?? '',
      discoveredModels: [...new Set([...provider.discoveredModels, ...modelsInPrefix])].sort(),
    });
  }

  function addCustomModel(index: number) {
    if (!settings) return;
    const provider = settings.providers[index];
    const key = providerKey(index);
    const model = (customModelDrafts[key] ?? '').trim();
    if (!model) return;
    updateProvider(index, { discoveredModels: [...new Set([...provider.discoveredModels, model])].sort() });
    setCustomModelDrafts((current) => ({ ...current, [key]: '' }));
  }

  async function probeProvider(index: number) {
    if (!settings) return;
    const provider = settings.providers[index];
    setProviderBusyLabel(index, '拉取中');
    try {
      const result = await probeLlmProviderModels(provider);
      updateProvider(index, {
        discoveredModels: [...new Set([...provider.discoveredModels, ...result.models])].sort(),
      });
      notify({
        title: `模型列表拉取成功：${provider.label || provider.id}`,
        description: `拉取到 ${result.models.length} 个候选模型 · ${result.source}`,
        variant: 'success',
      });
    } catch (err) {
      notify({
        title: `模型列表拉取失败：${provider.label || provider.id}`,
        description: (err as Error).message,
        variant: 'error',
      });
    } finally {
      setProviderBusyLabel(index, null);
    }
  }

  async function pingProvider(index: number) {
    if (!settings) return;
    const provider = settings.providers[index];
    setProviderBusyLabel(index, 'Ping');
    try {
      const ping = await pingLlmProvider(provider);
      const providerName = provider.label || provider.id;
      notify({
        title: `Ping ${ping.ok ? '成功' : '失败'}：${providerName}`,
        description: `${ping.latencyMs}ms · ${ping.message}${ping.modelCount ? ` · ${ping.modelCount} 个模型` : ''}`,
        variant: ping.ok ? 'success' : 'error',
      });
    } catch (err) {
      notify({
        title: `Ping 失败：${provider.label || provider.id}`,
        description: (err as Error).message,
        variant: 'error',
      });
    } finally {
      setProviderBusyLabel(index, null);
    }
  }

  function openChatTest(index: number) {
    if (!settings) return;
    const provider = settings.providers[index];
    const candidates = llmProviderCandidates(provider);
    setChatDialog({
      providerIndex: index,
      model: provider.defaultModel || provider.models[0] || candidates[0] || '',
      input: '请用一句中文回复：模型可用。',
    });
  }

  async function chatTestProvider() {
    if (!settings || !chatDialog || chatTesting) return;
    const provider = settings.providers[chatDialog.providerIndex];
    if (!provider) {
      setChatDialog(null);
      return;
    }
    setProviderBusyLabel(chatDialog.providerIndex, '对话检查');
    setChatTesting(true);
    setChatDialog({ ...chatDialog, result: undefined });
    try {
      const chat = await testLlmProviderChat(provider, chatDialog.model, chatDialog.input);
      setChatDialog((current) => current ? { ...current, result: chat } : current);
    } catch (err) {
      setChatDialog((current) => current ? {
        ...current,
        result: {
          ok: false,
          latencyMs: 0,
          model: chatDialog.model,
          input: chatDialog.input,
          output: (err as Error).message,
        },
      } : current);
    } finally {
      setChatTesting(false);
      setProviderBusyLabel(chatDialog.providerIndex, null);
    }
  }

  function addProvider() {
    if (!settings) return;
    const provider = defaultLlmProvider(settings.providers.length);
    setProviderUiKeys((current) => [...current, createLlmProviderUiKey()]);
    setSettings({
      ...settings,
      providers: [...settings.providers, provider],
      defaultModelRef: settings.defaultModelRef || llmModelRef(provider.id, provider.defaultModel),
    });
  }

  function removeProvider(index: number) {
    if (!settings) return;
    const providers = settings.providers.filter((_, providerIndex) => providerIndex !== index);
    const safeProviders = providers.length ? providers : [defaultLlmProvider(0)];
    const nextOptions = llmOptionsFromSettings({ ...settings, providers: safeProviders });
    setProviderUiKeys((current) => {
      const next = current.filter((_, providerIndex) => providerIndex !== index);
      return providers.length ? next : [createLlmProviderUiKey()];
    });
    setSettings({ ...settings, providers: safeProviders, defaultModelRef: nextOptions[0]?.ref ?? '' });
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setMessage('');
    try {
      const next = await updateLlmSettings(settings);
      setSettings(next);
      setOptions(await getLlmSettingsOptions());
      setMessage('已保存，新 run 会使用最新模型配置');
    } catch (err) {
      setMessage(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">正在读取配置...</div>;
  }
  const chatProvider = chatDialog ? settings.providers[chatDialog.providerIndex] : null;
  const chatCandidates = chatProvider ? llmProviderCandidates(chatProvider) : [];

  return (
    <SettingsPanelShell
      title="模型"
      description="主 agent 默认模型和 subagent 可用的 provider:model 候选"
      contentClassName="grid content-start gap-4"
      actions={
        <>
          {message && <span className="text-sm text-muted-foreground">{message}</span>}
          <Button onClick={() => void save()} disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? '保存中' : '保存'}
          </Button>
        </>
      }
    >

      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>默认模型</CardTitle>
          <CardDescription>主 agent 新 run 默认使用这里选择的模型；subagent 可在工具调用里指定同格式模型引用</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ModelSearchSelect
            value={settings.defaultModelRef}
            options={modelOptions}
            onChange={(defaultModelRef) => setSettings({ ...settings, defaultModelRef })}
          />
          <div className="text-xs text-muted-foreground">subagent_run 的 modelRef 示例：{settings.defaultModelRef || 'provider:model'}</div>
        </CardContent>
      </Card>

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">供应商</div>
          <Button variant="outline" size="sm" onClick={addProvider}>
            <Plus className="h-4 w-4" />
            新增供应商
          </Button>
        </div>
        {settings.providers.map((provider, index) => {
          const candidates = llmProviderCandidates(provider);
          const groupedModels = groupLlmModels(candidates);
          const enabledModelSet = new Set(provider.models);
          const providerUiKey = providerKey(index);
          const busyLabel = providerBusy[providerUiKey];
          const customKey = providerUiKey;
          const isProviderOpen = providerOpen[providerUiKey] ?? true;
          const providerModelOptions = provider.models.map((model) => ({
            ref: llmModelRef(provider.id, model),
            providerId: provider.id,
            providerLabel: provider.label || provider.id,
            provider: provider.provider,
            model,
            label: `${provider.label || provider.id} · ${model}`,
          }));
          return (
            <Collapsible
              key={providerUiKey}
              open={isProviderOpen}
              onOpenChange={(open) => setProviderOpen((current) => ({ ...current, [providerUiKey]: open }))}
              className="grid gap-4 rounded-lg border bg-card p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="-ml-2 shrink-0"
                      aria-label={`${isProviderOpen ? '收起' : '展开'}供应商 ${provider.label || provider.id}`}
                    >
                      <ChevronRight className={cn('h-4 w-4 transition-transform', isProviderOpen && 'rotate-90')} />
                    </Button>
                  </CollapsibleTrigger>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{provider.label || provider.id}</div>
                    <div className="truncate text-xs text-muted-foreground">{provider.defaultModel ? `${provider.id}:${provider.defaultModel}` : '未选择默认模型'}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge variant="outline">已启用 {provider.models.length}</Badge>
                      <Badge variant="outline">候选 {candidates.length}</Badge>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => void probeProvider(index)} disabled={Boolean(busyLabel)}>
                    <RefreshCw className={cn('h-4 w-4', busyLabel === '拉取中' && 'animate-spin')} />
                    拉取模型列表
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void pingProvider(index)} disabled={Boolean(busyLabel)}>
                    <Wifi className={cn('h-4 w-4', busyLabel === 'Ping' && 'animate-pulse')} />
                    Ping
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openChatTest(index)} disabled={Boolean(busyLabel) || candidates.length === 0}>
                    <MessageSquare className="h-4 w-4" />
                    模拟对话
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => removeProvider(index)} aria-label="删除供应商">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <CollapsibleContent className="grid gap-4 md:grid-cols-3">
                <Field label="供应商 ID">
                  <Input value={provider.id} onChange={(event) => updateProvider(index, { id: event.target.value })} />
                </Field>
                <Field label="显示名称">
                  <Input value={provider.label} onChange={(event) => updateProvider(index, { label: event.target.value })} />
                </Field>
                <Field label="适配器">
                  <Select value={provider.provider} onValueChange={(value) => updateProvider(index, { provider: value as LlmProviderSettings['provider'] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LLM_PROVIDER_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Base URL">
                  <Input value={provider.baseUrl} onChange={(event) => updateProvider(index, { baseUrl: event.target.value })} />
                </Field>
                <Field label="API Key">
                  <Input type="password" value={provider.apiKey} onChange={(event) => updateProvider(index, { apiKey: event.target.value })} />
                </Field>
                <Field label="AI SDK Flavor">
                  <Select value={provider.aisdkFlavor} onValueChange={(value) => updateProvider(index, { aisdkFlavor: value as LlmProviderSettings['aisdkFlavor'] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AI_SDK_FLAVOR_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="默认模型">
                  <ModelSearchSelect
                    value={provider.defaultModel ? llmModelRef(provider.id, provider.defaultModel) : ''}
                    options={providerModelOptions}
                    onChange={(ref) => updateProvider(index, { defaultModel: ref.slice(ref.indexOf(':') + 1) })}
                    placeholder={provider.models.length ? '选择默认模型' : '先启用模型'}
                  />
                </Field>
                <Field label="输出 token 上限">
                  <Input type="number" min={1} value={provider.maxTokens} onChange={(event) => updateProvider(index, { maxTokens: Number(event.target.value) })} />
                </Field>
                <Field label="超时毫秒">
                  <Input type="number" min={1000} value={provider.timeoutMs} onChange={(event) => updateProvider(index, { timeoutMs: Number(event.target.value) })} />
                </Field>
                <Field label="重试次数">
                  <Input type="number" min={0} value={provider.retries} onChange={(event) => updateProvider(index, { retries: Number(event.target.value) })} />
                </Field>
                <Field label="Reasoning Tag">
                  <Input value={provider.reasoningTag} onChange={(event) => updateProvider(index, { reasoningTag: event.target.value })} />
                </Field>
                <div className="grid gap-2 text-sm font-medium">
                  <span>流式输出</span>
                  <div className="inline-flex h-10 w-fit items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm">
                    <span className={cn(provider.stream ? 'text-foreground' : 'text-muted-foreground')}>开启</span>
                    <Switch checked={provider.stream} onCheckedChange={(stream) => updateProvider(index, { stream })} />
                  </div>
                </div>
                <div className="grid gap-2 md:col-span-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-medium">模型启用</div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="text-xs text-muted-foreground">已启用 {provider.models.length} / 候选 {candidates.length}</div>
                      {groupedModels.length > 0 && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => setModelGroupsOpen(index, groupedModels.map((group) => group.prefix), true)}
                          >
                            展开全部
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => setModelGroupsOpen(index, groupedModels.map((group) => group.prefix), false)}
                          >
                            收起全部
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <ScrollArea className="min-w-0 rounded-md border" viewportClassName="max-h-72 !h-auto">
                    <div className="grid divide-y">
                      {groupedModels.length === 0 && <div className="p-3 text-sm text-muted-foreground">暂无模型候选，可以先点击拉取模型列表，或添加自定义模型</div>}
                      {groupedModels.map((group) => {
                        const allChecked = group.models.every((model) => enabledModelSet.has(model));
                        const someChecked = group.models.some((model) => enabledModelSet.has(model));
                        const groupOpen = isModelGroupOpen(index, group.prefix);
                        return (
                          <Collapsible
                            key={group.prefix}
                            open={groupOpen}
                            onOpenChange={(open) => setModelGroupOpen((current) => ({ ...current, [modelGroupKey(index, group.prefix)]: open }))}
                            className="grid gap-2 p-3"
                          >
                            <div className="flex min-w-0 items-center justify-between gap-3">
                              <label className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                                <Checkbox checked={allChecked} onCheckedChange={(checked) => setPrefixEnabled(index, group.models, checked === true)} />
                                <span className="truncate">{group.prefix}</span>
                                <Badge variant="outline">{someChecked && !allChecked ? `${provider.models.filter((model) => group.models.includes(model)).length}/${group.models.length}` : group.models.length}</Badge>
                              </label>
                              <CollapsibleTrigger asChild>
                                <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" aria-label={`${groupOpen ? '收起' : '展开'} ${group.prefix} 模型`}>
                                  <ChevronRight className={cn('h-4 w-4 transition-transform', groupOpen && 'rotate-90')} />
                                </Button>
                              </CollapsibleTrigger>
                            </div>
                            <CollapsibleContent>
                              <div className="grid gap-1 md:grid-cols-2">
                                {group.models.map((model) => (
                                  <label key={model} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/60">
                                    <Checkbox checked={enabledModelSet.has(model)} onCheckedChange={(checked) => setModelEnabled(index, model, checked === true)} />
                                    <span className="min-w-0 truncate">{model}</span>
                                  </label>
                                ))}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <Field label="添加自定义模型">
                    <div className="flex min-w-0 gap-2">
                      <Input
                        value={customModelDrafts[customKey] ?? ''}
                        placeholder="例如 vendor-model-name"
                        onChange={(event) => setCustomModelDrafts((current) => ({ ...current, [customKey]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addCustomModel(index);
                          }
                        }}
                      />
                      <Button type="button" variant="outline" onClick={() => addCustomModel(index)}>
                        <Plus className="h-4 w-4" />
                        添加
                      </Button>
                    </div>
                  </Field>
                  <div className="text-xs text-muted-foreground">
                    自定义模型只会进入候选列表，勾选后才启用。
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
      <Dialog open={Boolean(chatDialog)} onOpenChange={(open) => !open && setChatDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>模拟对话</DialogTitle>
            <DialogDescription>选择一个候选模型并输入测试内容，后端会发起一次真实模型调用。</DialogDescription>
          </DialogHeader>
          {chatDialog && chatProvider && (
            <div className="grid gap-4">
              <Field label="测试模型">
                <Select value={chatDialog.model} onValueChange={(model) => setChatDialog({ ...chatDialog, model })} disabled={chatTesting}>
                  <SelectTrigger><SelectValue placeholder="选择模型" /></SelectTrigger>
                  <SelectContent>
                    {chatCandidates.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="输入内容">
                <Textarea
                  rows={6}
                  value={chatDialog.input}
                  disabled={chatTesting}
                  onChange={(event) => setChatDialog({ ...chatDialog, input: event.target.value })}
                />
              </Field>
              {chatDialog.result && (
                <div
                  className={cn(
                    'grid gap-2 rounded-md border bg-muted/30 p-3 text-sm',
                    chatDialog.result.ok ? 'border-emerald-500/40' : 'border-destructive/50',
                  )}
                >
                  <div className={cn('font-medium', chatDialog.result.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>
                    模拟对话{chatDialog.result.ok ? '成功' : '失败'} · {chatDialog.result.model} · {chatDialog.result.latencyMs}ms
                  </div>
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">{chatDialog.result.output}</div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setChatDialog(null)} disabled={chatTesting}>取消</Button>
            <Button onClick={() => void chatTestProvider()} disabled={chatTesting || !chatDialog?.model || !chatDialog?.input.trim()}>
              {chatTesting ? <Spinner className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
              {chatTesting ? '发送中' : '发送测试'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPanelShell>
  );
}

export function SettingsView({
  embedded = false,
  onThreadsChanged,
  onWorkspaceChanged,
}: {
  embedded?: boolean;
  onThreadsChanged?: () => void;
  onWorkspaceChanged: () => void;
}) {
  const [panel, setPanel] = useState<SettingsPanel>('appearance');

  return (
    <main className={cn(embedded ? 'min-h-0 flex-1 bg-background' : 'app-main-surface h-full flex-1 overflow-y-auto')}>
      <div className={cn('mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5', embedded && 'h-full min-h-0 w-full')}>
        {!embedded && <div>
          <h1 className="text-xl font-semibold">设置</h1>
        </div>}

        <div className={cn('grid items-start gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]', embedded && 'h-full min-h-0 flex-1')}>
          <Card className={cn('rounded-lg shadow-sm', embedded ? 'h-full min-h-0 overflow-hidden' : 'h-fit')}>
            <CardContent className={cn('grid gap-2 p-3', embedded && 'max-h-full overflow-y-auto')}>
              <NavGroup label="外观">
                <SectionButton active={panel === 'appearance'} icon={<Palette className="h-4 w-4" />} onClick={() => setPanel('appearance')}>
                  外观
                </SectionButton>
                <SectionButton active={panel === 'status-card'} icon={<Gauge className="h-4 w-4" />} onClick={() => setPanel('status-card')}>
                  状态卡片
                </SectionButton>
              </NavGroup>
              <NavGroup label="用量">
                <SectionButton active={panel === 'usage-stats'} icon={<Activity className="h-4 w-4" />} onClick={() => setPanel('usage-stats')}>
                  用量统计
                </SectionButton>
              </NavGroup>
              <NavGroup label="会话">
                <SectionButton active={panel === 'archived-threads'} icon={<ArchiveRestore className="h-4 w-4" />} onClick={() => setPanel('archived-threads')}>
                  已归档
                </SectionButton>
              </NavGroup>
              <NavGroup label="模型">
                <SectionButton active={panel === 'llm-models'} icon={<Bot className="h-4 w-4" />} onClick={() => setPanel('llm-models')}>
                  模型
                </SectionButton>
              </NavGroup>
              <NavGroup label="工具">
                <SectionButton active={panel === 'tools-access'} icon={<Shield className="h-4 w-4" />} onClick={() => setPanel('tools-access')}>
                  工具准入
                </SectionButton>
                <SectionButton active={panel === 'tools-sandbox'} icon={<Wrench className="h-4 w-4" />} onClick={() => setPanel('tools-sandbox')}>
                  Shell / 沙箱
                </SectionButton>
                <SectionButton active={panel === 'mcp-client'} icon={<Wifi className="h-4 w-4" />} onClick={() => setPanel('mcp-client')}>
                  MCP Client
                </SectionButton>
              </NavGroup>
            </CardContent>
          </Card>

          <div className={cn('min-w-0', embedded && 'h-full min-h-0 overflow-hidden pr-1')}>
            {panel === 'appearance' && <AppearanceSettingsPanel />}
            {panel === 'status-card' && <StatusCardSettingsPanel />}
            {panel === 'usage-stats' && <UsageStatsSettingsPanel />}
            {panel === 'archived-threads' && <ArchivedThreadsSettingsPanel onThreadsChanged={onThreadsChanged} />}
            {panel === 'llm-models' && <LlmSettingsPanel />}
            {panel === 'mcp-client' && <McpSettingsPanel />}
            {panel === 'tools-access' && <ToolsSettingsPanel onWorkspaceChanged={onWorkspaceChanged} section="access" />}
            {panel === 'tools-sandbox' && <ToolsSettingsPanel onWorkspaceChanged={onWorkspaceChanged} section="sandbox-shell" />}
          </div>
        </div>
      </div>
    </main>
  );
}
