import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { StorageUsageBreakdown, TokenUsageBreakdown, UsageAggregateResponse } from '@runforge/contracts';
import type { UsageQuery } from '@/usageApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface UsageAnalyticsPanelProps {
  load: (query: UsageQuery) => Promise<UsageAggregateResponse>;
  showTenantFilter?: boolean;
  showUserFilter?: boolean;
  refreshStorage?: () => Promise<void>;
}

const CATEGORY_LABELS: Record<string, string> = {
  thread_uploads: '会话上传文件',
  thread_agent_runtime: 'Agent 运行目录',
  thread_plugins: '会话插件入口',
  thread_workspace: '会话工作目录',
  external_artifacts: '外部调用产物',
  business_plugin_current: '业务插件当前版本',
  business_plugin_snapshots: '业务插件历史快照',
  database_logical: '数据库逻辑数据',
};

function formatMetric(value: number): string {
  return value.toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function TokenBreakdownTable({ title, rows }: { title: string; rows: TokenUsageBreakdown[] }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>项目</TableHead><TableHead className="text-right">有效 Token</TableHead><TableHead className="text-right">尝试 Token</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.slice(0, 12).map((row) => (
              <TableRow key={`${row.tenantId ?? ''}:${row.id}`}>
                <TableCell className="max-w-64 truncate" title={row.label}>{row.label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.effectiveTokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.attemptedTokens)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function StorageBreakdownTable({ rows }: { rows: StorageUsageBreakdown[] }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader className="pb-2"><CardTitle className="text-base">存储分类</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>分类</TableHead><TableHead className="text-right">逻辑大小</TableHead><TableHead className="text-right">磁盘分配</TableHead><TableHead className="text-right">文件 / 链接</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{CATEGORY_LABELS[row.id] ?? row.label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(row.logicalBytes)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(row.allocatedBytes)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.fileCount)} / {formatMetric(row.symlinkCount)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">等待首次存储扫描</TableCell></TableRow>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function UsageAnalyticsPanel({
  load,
  showTenantFilter = false,
  showUserFilter = true,
  refreshStorage,
}: UsageAnalyticsPanelProps) {
  const [rangeDays, setRangeDays] = useState(84);
  const [tenantId, setTenantId] = useState('all');
  const [userId, setUserId] = useState('all');
  const [spaceId, setSpaceId] = useState('all');
  const [data, setData] = useState<UsageAggregateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const requestSequence = useRef(0);

  const query = useMemo<UsageQuery>(() => ({
    rangeDays,
    tenantId: tenantId === 'all' ? null : tenantId,
    userId: userId === 'all' ? null : userId,
    spaceId: spaceId === 'all' ? null : spaceId,
  }), [rangeDays, spaceId, tenantId, userId]);

  const refresh = useCallback(async (scanStorage = false) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setMessage('');
    try {
      if (scanStorage && refreshStorage) await refreshStorage();
      const result = await load(query);
      if (sequence === requestSequence.current) setData(result);
    } catch (error) {
      if (sequence === requestSequence.current) setMessage(`读取用量失败：${(error as Error).message}`);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [load, query, refreshStorage]);

  useEffect(() => { void refresh(); }, [refresh]);

  const dailyMap = useMemo(() => new Map(data?.tokens.daily.map((day) => [day.date, day]) ?? []), [data]);
  const heatmapDays = useMemo(() => {
    const weekCount = Math.ceil(rangeDays / 7);
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(start.getDate() - (weekCount * 7 - 1));
    return Array.from({ length: weekCount * 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = localDateKey(date);
      return { date: key, tokens: dailyMap.get(key)?.attemptedTokens ?? 0, future: date > today };
    });
  }, [dailyMap, rangeDays]);
  const heatmapWeekCount = Math.ceil(heatmapDays.length / 7);
  const heatmapWeeks = Array.from({ length: heatmapWeekCount }, (_, week) => heatmapDays.slice(week * 7, week * 7 + 7));
  const maxDaily = Math.max(1, ...heatmapDays.map((day) => day.tokens));
  const options = data?.options;
  const users = options?.users.filter((option) => tenantId === 'all' || option.tenantId === tenantId) ?? [];
  const spaces = options?.spaces.filter((option) => tenantId === 'all' || option.tenantId === tenantId) ?? [];
  const storageHistory = data?.storage.history ?? [];
  const maxStorage = Math.max(1, ...storageHistory.map((point) => point.logicalBytes));

  return (
    <div className="grid h-full min-h-0 content-start gap-4 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(rangeDays)} onValueChange={(value) => setRangeDays(Number(value))}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="30">最近 30 天</SelectItem><SelectItem value="84">最近 12 周</SelectItem><SelectItem value="365">最近一年</SelectItem></SelectContent>
        </Select>
        {showTenantFilter && (
          <Select value={tenantId} onValueChange={(value) => { setTenantId(value); setUserId('all'); setSpaceId('all'); }}>
            <SelectTrigger className="w-52"><SelectValue placeholder="全部租户" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部租户</SelectItem>{options?.tenants.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {showUserFilter && (
          <Select value={userId} onValueChange={(value) => { setUserId(value); setSpaceId('all'); }}>
            <SelectTrigger className="w-52"><SelectValue placeholder="全部用户" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部用户</SelectItem>{users.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <Select value={spaceId} onValueChange={setSpaceId}>
          <SelectTrigger className="w-52"><SelectValue placeholder="全部空间" /></SelectTrigger>
          <SelectContent><SelectItem value="all">全部空间</SelectItem>{spaces.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void refresh(Boolean(refreshStorage))} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          {refreshStorage ? '重新扫描' : '刷新'}
        </Button>
        {message && <span className="text-sm text-destructive">{message}</span>}
      </div>

      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>有效 Token</CardDescription><CardTitle>{formatMetric(data?.tokens.totals.effectiveTokens ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">成功请求的输入与输出</CardContent></Card>
        <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>尝试 Token</CardDescription><CardTitle>{formatMetric(data?.tokens.totals.attemptedTokens ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">包含失败和重试，共 {formatMetric(data?.tokens.totals.attempts ?? 0)} 次尝试</CardContent></Card>
        <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>缓存输入</CardDescription><CardTitle>{formatMetric(data?.tokens.totals.cachedInputTokens ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">属于输入 Token 的缓存部分</CardContent></Card>
        <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>当前存储</CardDescription><CardTitle>{formatBytes(data?.storage.totals.logicalBytes ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">磁盘分配 {formatBytes(data?.storage.totals.allocatedBytes ?? 0)} · {data?.storage.capturedAt ? new Date(data.storage.capturedAt).toLocaleString() : '等待扫描'}</CardContent></Card>
      </div>

      <Card className="rounded-lg shadow-sm">
        <CardHeader><CardTitle>每日 Token</CardTitle><CardDescription>当前时间范围；失败和重试也会消耗供应商额度，因此热力图展示尝试 Token</CardDescription></CardHeader>
        <CardContent className="grid gap-3 overflow-x-auto">
          <div className="grid w-max gap-1" style={{ gridTemplateColumns: `auto repeat(${heatmapWeekCount}, 0.875rem)` }}>
            <div />
            {heatmapWeeks.map((week, index) => <div key={week[0]?.date ?? index} className="h-3 text-[10px] tabular-nums text-muted-foreground">{index % 3 === 0 ? week[0]?.date.slice(5) : ''}</div>)}
            {['日', '一', '二', '三', '四', '五', '六'].map((weekday, row) => (
              <Fragment key={weekday}>
                <div className="flex h-3 items-center pr-1 text-[10px] text-muted-foreground">{row % 2 === 1 ? weekday : ''}</div>
                {heatmapWeeks.map((week, column) => {
                  const day = week[row];
                  const ratio = (day?.tokens ?? 0) / maxDaily;
                  return <div key={`${day?.date ?? column}-${row}`} className={cn('size-3 rounded-[2px] border border-border/60', day?.future && 'opacity-35')} style={{ backgroundColor: day?.future ? 'transparent' : day?.tokens ? `hsl(var(--primary) / ${Math.max(0.18, ratio).toFixed(2)})` : 'hsl(var(--muted))' }} title={day ? `${day.date} · ${formatMetric(day.tokens)} Token` : '暂无数据'} />;
                })}
              </Fragment>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {showTenantFilter && <TokenBreakdownTable title="按租户" rows={data?.tokens.byTenant ?? []} />}
        {showUserFilter && <TokenBreakdownTable title="按用户" rows={data?.tokens.byUser ?? []} />}
        <TokenBreakdownTable title="按空间" rows={data?.tokens.bySpace ?? []} />
        <TokenBreakdownTable title="按模型" rows={data?.tokens.byModel ?? []} />
      </div>
      <Card className="rounded-lg shadow-sm">
        <CardHeader><CardTitle>存储趋势</CardTitle><CardDescription>每日时点逻辑大小；历史从启用采样后开始积累</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          {storageHistory.length > 0 ? (
            <div className="flex h-36 min-w-max items-end gap-1 border-b pb-1">
              {storageHistory.map((point) => (
                <div
                  key={point.at}
                  className="w-2 shrink-0 rounded-t-sm bg-primary/75"
                  style={{ height: `${Math.max(3, (point.logicalBytes / maxStorage) * 132)}px` }}
                  title={`${new Date(point.at).toLocaleDateString()} · ${formatBytes(point.logicalBytes)}`}
                />
              ))}
            </div>
          ) : <div className="py-10 text-center text-sm text-muted-foreground">日样本将在首次扫描后显示</div>}
        </CardContent>
      </Card>
      <StorageBreakdownTable rows={data?.storage.byCategory ?? []} />
    </div>
  );
}
