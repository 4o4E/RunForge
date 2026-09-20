import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArchiveRestore, Moon, Palette, Plus, RefreshCw, Save, Sun, Trash2 } from 'lucide-react';
import {
  getThread,
  listThreads,
  updateThread,
  type AgentEvent,
  type LlmSettings,
  type McpServerProbeResult,
  type McpServerSettings,
  type McpSettings,
  type McpSettingsOptions,
  type McpToolOption,
  type RuntimeCapabilitiesSettings,
  type RuntimeImageCapabilityModel,
  type RuntimeLlmCapabilityModel,
  type RuntimeVideoCapabilityModel,
  type Thread,
  type ToolSettings,
  type ToolSettingsOptions,
} from '../api';
import type { SettingsControlApi } from '../controlApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ModelSearchSelect, llmOptionsFromSettings } from './ModelSearchSelect';
import { useThemeCtx } from '@/theme';
import { useNotifications } from './GlobalNotifications';
import { NavGroup, SectionButton } from '@/components/ui/settings-nav';

type SettingsPanel =
  | 'appearance'
  | 'usage-stats'
  | 'archived-threads';

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
    description: '描述这个 MCP Server 提供的能力。',
    enabled: false,
    url: '',
    bearerToken: '',
    headers: [],
    timeoutMs: 60000,
    maxOutput: 40000,
  };
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

export function ToolsSettingsPanel({
  controlApi,
}: {
  controlApi: SettingsControlApi;
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
    Promise.all([controlApi.getToolSettings(), controlApi.getToolSettingsOptions()])
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
  }, [controlApi]);

  const prepared = useMemo<ToolSettings | null>(() => {
    if (!settings) return null;
    return {
      ...settings,
      shellDeny: textToList(shellDenyText),
      maxOutput: Math.max(1000, Math.floor(Number(settings.maxOutput) || 1000)),
    };
  }, [settings, shellDenyText]);

  const shellCommandOptions = options?.shellCommands ?? [];
  const filteredShellCommandOptions = useMemo(() => {
    const query = shellCommandQuery.trim().toLowerCase();
    if (!query) return shellCommandOptions;
    return shellCommandOptions.filter((command) => {
      const path = command.path ?? '';
      return command.name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
    });
  }, [shellCommandOptions, shellCommandQuery]);
  const shellCommandSet = useMemo(() => new Set(settings?.shellAllowCommands ?? []), [settings?.shellAllowCommands]);

  function setShellCommand(name: string, checked: boolean) {
    if (!settings) return;
    setSettings({ ...settings, shellAllowCommands: toggleListValue(settings.shellAllowCommands, name, checked) });
  }

  async function scanShellCommands() {
    if (!settings || !options) return;
    setScanning(true);
    setMessage('');
    try {
      const result = await controlApi.scanShellCommandOptions({
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
      const next = await controlApi.updateToolSettings(prepared);
      setSettings(next);
      setOptions(await controlApi.getToolSettingsOptions());
      setShellDenyText(listToText(next.shellDeny));
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
  return (
    <SettingsPanelShell
      title="Shell / 沙箱"
      description="原生工具默认加载；这里仅配置 Shell 执行方式、bwrap 后端、PATH 和可见指令"
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
      <div className="grid gap-4">
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
    </SettingsPanelShell>
  );
}

export function McpSettingsPanel({ controlApi }: { controlApi: SettingsControlApi }) {
  const { notify } = useNotifications();
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [options, setOptions] = useState<McpSettingsOptions | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, McpServerProbeResult>>({});
  const [message, setMessage] = useState('');

  async function reload() {
    const [nextSettings, nextOptions] = await Promise.all([controlApi.getMcpSettings(), controlApi.getMcpSettingsOptions()]);
    setSettings(nextSettings);
    setOptions(nextOptions);
  }

  useEffect(() => {
    reload().catch((err) => setMessage((err as Error).message));
  }, [controlApi]);

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

  async function save() {
    if (!settings) return;
    setSaving(true);
    setMessage('');
    try {
      const next = await controlApi.updateMcpSettings(settings);
      setSettings(next);
      setOptions(await controlApi.getMcpSettingsOptions());
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
      const result = await controlApi.probeMcpServer(server);
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
      description="连接外部 MCP Server；工具只在当前 run 激活后加载"
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
                  <div className="md:col-span-2"><Field label="能力描述"><Textarea rows={3} value={server.description} onChange={(event) => updateServer(index, { description: event.target.value })} /></Field></div>
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
                  <div><div className="text-sm font-medium">激活后加载的工具</div><div className="text-xs text-muted-foreground">当前 Server 返回的全部工具会加入当前 run</div></div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-xs text-muted-foreground">已发现 {serverTools.length}</div>
                  </div>
                </div>
                <div className="grid divide-y rounded-md border">
                  {!serverTools.length && <div className="p-3 text-sm text-muted-foreground">还没有发现工具，请先测试连接</div>}
                  {serverTools.map((tool) => (
                    <div key={tool.mappedName} className="flex items-start justify-between gap-3 p-3">
                      <div className="min-w-0"><div className="break-all text-sm font-medium">{tool.name}</div><div className="text-xs text-muted-foreground">{tool.description}</div></div>
                      <Badge variant="outline">{tool.mappedName}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </SettingsPanelShell>
  );
}

export function RuntimeCapabilitiesSettingsPanel({ controlApi }: { controlApi: SettingsControlApi }) {
  const { notify } = useNotifications();
  const [settings, setSettings] = useState<RuntimeCapabilitiesSettings | null>(null);
  const [llmSettings, setLlmSettings] = useState<LlmSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    controlApi.getRuntimeCapabilitiesSettings()
      .then(setSettings)
      .catch((err) => notify({ variant: 'error', title: '运行时能力配置加载失败', description: (err as Error).message }));
    controlApi.getLlmSettings()
      .then(setLlmSettings)
      .catch((err) => notify({ variant: 'error', title: '模型配置加载失败', description: (err as Error).message }));
  }, [controlApi, notify]);

  if (!settings) {
    return <SettingsPanelShell title="运行时能力" description="WORKLOAD_TOKEN 可换取的内部代理能力"><div className="text-sm text-muted-foreground">加载中...</div></SettingsPanelShell>;
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      const next = await controlApi.updateRuntimeCapabilitiesSettings(settings);
      setSettings(next);
      notify({ variant: 'success', title: '运行时能力配置已保存' });
    } catch (err) {
      notify({ variant: 'error', title: '运行时能力配置保存失败', description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const llmOptions = llmSettings ? llmOptionsFromSettings(llmSettings) : [];
  const updateLlmModel = (index: number, patch: Partial<RuntimeLlmCapabilityModel>) => {
    const models = settings.llm.models.map((model, i) => i === index ? { ...model, ...patch } : model);
    const defaultModelId = models.some((model) => model.id === settings.llm.defaultModelId) ? settings.llm.defaultModelId : models[0]?.id ?? '';
    setSettings({ ...settings, llm: { ...settings.llm, models, defaultModelId } });
  };
  const addLlmModel = () => {
    const id = `llm-${settings.llm.models.length + 1}`;
    const modelRef = llmOptions[0]?.ref ?? '';
    setSettings({
      ...settings,
      llm: {
        ...settings.llm,
        defaultModelId: settings.llm.defaultModelId || id,
        models: [...settings.llm.models, { id, label: modelRef || id, modelRef }],
      },
    });
  };
  const removeLlmModel = (index: number) => {
    const models = settings.llm.models.filter((_, i) => i !== index);
    setSettings({
      ...settings,
      llm: {
        ...settings.llm,
        models,
        defaultModelId: models.some((model) => model.id === settings.llm.defaultModelId) ? settings.llm.defaultModelId : models[0]?.id ?? '',
      },
    });
  };
  const updateImageModel = (index: number, patch: Partial<RuntimeImageCapabilityModel>) => {
    const models = settings.image.models.map((model, i) => i === index ? { ...model, ...patch } : model);
    const defaultModelId = models.some((model) => model.id === settings.image.defaultModelId) ? settings.image.defaultModelId : models[0]?.id ?? '';
    setSettings({ ...settings, image: { ...settings.image, models, defaultModelId } });
  };
  const addImageModel = () => {
    const id = `image-${settings.image.models.length + 1}`;
    setSettings({
      ...settings,
      image: {
        ...settings.image,
        defaultModelId: settings.image.defaultModelId || id,
        models: [...settings.image.models, { id, label: 'GPT Image 2', provider: 'packy-gpt-image-2', baseUrl: 'https://cf.api.fan', apiKey: '', model: 'gpt-image-2', timeoutMs: 180000 }],
      },
    });
  };
  const removeImageModel = (index: number) => {
    const models = settings.image.models.filter((_, i) => i !== index);
    setSettings({
      ...settings,
      image: {
        ...settings.image,
        models,
        defaultModelId: models.some((model) => model.id === settings.image.defaultModelId) ? settings.image.defaultModelId : models[0]?.id ?? '',
      },
    });
  };
  const updateVideoModel = (index: number, patch: Partial<RuntimeVideoCapabilityModel>) => {
    const models = settings.video.models.map((model, i) => i === index ? { ...model, ...patch } : model);
    const defaultModelId = models.some((model) => model.id === settings.video.defaultModelId) ? settings.video.defaultModelId : models[0]?.id ?? '';
    setSettings({ ...settings, video: { ...settings.video, models, defaultModelId } });
  };
  const addVideoModel = () => {
    const id = `video-${settings.video.models.length + 1}`;
    setSettings({
      ...settings,
      video: {
        ...settings.video,
        defaultModelId: settings.video.defaultModelId || id,
        models: [...settings.video.models, { id, label: '视频模型', provider: 'todo-provider', model: 'todo-model' }],
      },
    });
  };
  const removeVideoModel = (index: number) => {
    const models = settings.video.models.filter((_, i) => i !== index);
    setSettings({
      ...settings,
      video: {
        ...settings.video,
        models,
        defaultModelId: models.some((model) => model.id === settings.video.defaultModelId) ? settings.video.defaultModelId : models[0]?.id ?? '',
      },
    });
  };

  return (
    <SettingsPanelShell
      title="运行时能力"
      description="控制 WORKLOAD_TOKEN 可以换取哪些内部代理凭证"
      actions={<Button onClick={() => void save()} disabled={busy}>{busy ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}保存</Button>}
      contentClassName="grid content-start gap-4"
    >
      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>能力开关</CardTitle>
          <CardDescription>开关实时影响接口硬过滤，新 run 的系统提示词会按创建时快照注入</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <label className="flex items-center justify-between gap-3 rounded-md border p-3">
            <span className="grid gap-1">
              <span className="text-sm font-medium">LLM 代理凭证</span>
              <span className="text-xs text-muted-foreground">允许脚本换取 llm 能力代理配置</span>
            </span>
            <Switch checked={settings.llm.enabled} onCheckedChange={(enabled) => setSettings({ ...settings, llm: { ...settings.llm, enabled } })} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3">
            <span className="grid gap-1">
              <span className="text-sm font-medium">图片生成凭证</span>
              <span className="text-xs text-muted-foreground">允许脚本换取 image 能力代理配置</span>
            </span>
            <Switch checked={settings.image.enabled} onCheckedChange={(enabled) => setSettings({ ...settings, image: { ...settings.image, enabled } })} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3">
            <span className="grid gap-1">
              <span className="text-sm font-medium">视频生成凭证</span>
              <span className="text-xs text-muted-foreground">预留能力，v1 接口会返回未接入 provider</span>
            </span>
            <Switch checked={settings.video.enabled} onCheckedChange={(enabled) => setSettings({ ...settings, video: { ...settings.video, enabled } })} />
          </label>
        </CardContent>
      </Card>

      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>LLM 模型</CardTitle>
          <CardDescription>代码可通过 model 选择这些运行时模型 id</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <Select value={settings.llm.defaultModelId || 'none'} onValueChange={(value) => setSettings({ ...settings, llm: { ...settings.llm, defaultModelId: value === 'none' ? '' : value } })}>
              <SelectTrigger className="max-w-xs"><SelectValue placeholder="默认模型" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无默认模型</SelectItem>
                {settings.llm.models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label || model.id}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={addLlmModel}><Plus className="h-4 w-4" />新增模型</Button>
          </div>
          {settings.llm.models.map((model, index) => (
            <div key={`${model.id}-${index}`} className="grid gap-3 rounded-md border p-3 md:grid-cols-3">
              <Field label="模型 ID">
                <Input value={model.id} onChange={(event) => updateLlmModel(index, { id: event.target.value })} />
              </Field>
              <Field label="显示名称">
                <Input value={model.label} onChange={(event) => updateLlmModel(index, { label: event.target.value })} />
              </Field>
              <div className="flex items-end gap-2">
                <Field label="后端 modelRef">
                  <ModelSearchSelect value={model.modelRef} options={llmOptions} onChange={(modelRef) => updateLlmModel(index, { modelRef })} placeholder="选择模型" />
                </Field>
                <Button variant="ghost" size="icon" className="mb-0.5 size-9" onClick={() => removeLlmModel(index)} aria-label="删除 LLM 模型">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>图片模型</CardTitle>
          <CardDescription>每个模型条目独立保存 Packy GPT-Image-2 代理配置</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <Select value={settings.image.defaultModelId || 'none'} onValueChange={(value) => setSettings({ ...settings, image: { ...settings.image, defaultModelId: value === 'none' ? '' : value } })}>
              <SelectTrigger className="max-w-xs"><SelectValue placeholder="默认模型" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无默认模型</SelectItem>
                {settings.image.models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label || model.id}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={addImageModel}><Plus className="h-4 w-4" />新增模型</Button>
          </div>
          {settings.image.models.map((model, index) => (
            <div key={`${model.id}-${index}`} className="grid gap-3 rounded-md border p-3 md:grid-cols-3">
              <Field label="模型 ID">
                <Input value={model.id} onChange={(event) => updateImageModel(index, { id: event.target.value })} />
              </Field>
              <Field label="显示名称">
                <Input value={model.label} onChange={(event) => updateImageModel(index, { label: event.target.value })} />
              </Field>
              <Field label="上游模型">
                <Input value={model.model} onChange={(event) => updateImageModel(index, { model: event.target.value })} />
              </Field>
              <Field label="Base URL">
                <Input value={model.baseUrl} onChange={(event) => updateImageModel(index, { baseUrl: event.target.value })} />
              </Field>
              <Field label="API Key">
                <Input type="password" value={model.apiKey} onChange={(event) => updateImageModel(index, { apiKey: event.target.value })} />
              </Field>
              <div className="flex items-end gap-2">
                <Field label="Timeout ms">
                  <Input type="number" min={1000} value={model.timeoutMs} onChange={(event) => updateImageModel(index, { timeoutMs: Number(event.target.value) })} />
                </Field>
                <Button variant="ghost" size="icon" className="mb-0.5 size-9" onClick={() => removeImageModel(index)} aria-label="删除图片模型">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle>视频模型</CardTitle>
          <CardDescription>预留配置，v1 仍返回未接入 provider</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <Select value={settings.video.defaultModelId || 'none'} onValueChange={(value) => setSettings({ ...settings, video: { ...settings.video, defaultModelId: value === 'none' ? '' : value } })}>
              <SelectTrigger className="max-w-xs"><SelectValue placeholder="默认模型" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无默认模型</SelectItem>
                {settings.video.models.map((model) => <SelectItem key={model.id} value={model.id}>{model.label || model.id}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={addVideoModel}><Plus className="h-4 w-4" />新增模型</Button>
          </div>
          {settings.video.models.map((model, index) => (
            <div key={`${model.id}-${index}`} className="grid gap-3 rounded-md border p-3 md:grid-cols-4">
              <Field label="模型 ID">
                <Input value={model.id} onChange={(event) => updateVideoModel(index, { id: event.target.value })} />
              </Field>
              <Field label="显示名称">
                <Input value={model.label} onChange={(event) => updateVideoModel(index, { label: event.target.value })} />
              </Field>
              <Field label="Provider">
                <Input value={model.provider} onChange={(event) => updateVideoModel(index, { provider: event.target.value })} />
              </Field>
              <div className="flex items-end gap-2">
                <Field label="Model">
                  <Input value={model.model} onChange={(event) => updateVideoModel(index, { model: event.target.value })} />
                </Field>
                <Button variant="ghost" size="icon" className="mb-0.5 size-9" onClick={() => removeVideoModel(index)} aria-label="删除视频模型">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </SettingsPanelShell>
  );
}

export function SettingsView() {
  const [panel, setPanel] = useState<SettingsPanel>('appearance');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid h-full min-h-0 max-w-7xl items-start gap-4 px-6 py-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <Card className="h-full min-h-0 overflow-hidden rounded-lg shadow-sm">
            <CardContent className="grid max-h-full gap-2 overflow-y-auto p-3">
              <NavGroup label="外观">
                <SectionButton active={panel === 'appearance'} icon={<Palette className="h-4 w-4" />} onClick={() => setPanel('appearance')}>
                  外观
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
            </CardContent>
          </Card>

          <div className="h-full min-h-0 min-w-0 overflow-hidden pr-1">
            {panel === 'appearance' && <AppearanceSettingsPanel />}
            {panel === 'usage-stats' && <UsageStatsSettingsPanel />}
            {panel === 'archived-threads' && <ArchivedThreadsSettingsPanel />}
          </div>
      </div>
    </div>
  );
}
