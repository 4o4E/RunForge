import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { UsageAggregateResponse } from '@runforge/contracts';
import type { UsageQuery } from '@/usageApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatBytes, formatMetric, shanghaiTime } from './UsageChart';
import { DailyTokenChart, StorageCategoryChart, StorageHistoryChart, StorageSpaceChart, TokenBreakdownChart } from './UsageAnalyticsCharts';

interface UsageAnalyticsPanelProps {
  view: 'usage' | 'storage';
  load: (query: UsageQuery) => Promise<UsageAggregateResponse>;
  showTenantFilter?: boolean;
  showUserFilter?: boolean;
  refreshStorage?: () => Promise<void>;
}

export function UsageAnalyticsPanel({
  view,
  load,
  showTenantFilter = false,
  showUserFilter = true,
  refreshStorage,
}: UsageAnalyticsPanelProps) {
  const [rangeDays, setRangeDays] = useState(84);
  const [tenantId, setTenantId] = useState('all');
  const [userId, setUserId] = useState('all');
  const [spaceId, setSpaceId] = useState('all');
  const [response, setResponse] = useState<{
    query: UsageQuery;
    load: UsageAnalyticsPanelProps['load'];
    data: UsageAggregateResponse;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const requestSequence = useRef(0);

  const query = useMemo<UsageQuery>(() => ({
    rangeDays,
    tenantId: tenantId === 'all' ? null : tenantId,
    userId: userId === 'all' ? null : userId,
    spaceId: spaceId === 'all' ? null : spaceId,
  }), [rangeDays, spaceId, tenantId, userId]);
  // 响应同时绑定查询和读取权限上下文，切换筛选后的首次渲染也不会展示旧数据。
  const data = response?.query === query && response.load === load ? response.data : null;
  const options = response?.load === load ? response.data.options : undefined;

  const refresh = useCallback(async (scanStorage = false) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setMessage('');
    try {
      if (scanStorage && refreshStorage) await refreshStorage();
      if (sequence !== requestSequence.current) return;
      const result = await load(query);
      if (sequence === requestSequence.current) setResponse({ query, load, data: result });
    } catch (error) {
      if (sequence === requestSequence.current) setMessage(`读取${view === 'storage' ? '存储' : '用量'}失败：${(error as Error).message}`);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [load, query, refreshStorage, view]);

  useEffect(() => {
    void refresh();
    return () => { requestSequence.current += 1; };
  }, [refresh]);

  function changeFilter(change: () => void) {
    requestSequence.current += 1;
    setMessage('');
    change();
  }

  const users = options?.users.filter((option) => tenantId === 'all' || option.tenantId === tenantId) ?? [];
  const spaces = options?.spaces.filter((option) => tenantId === 'all' || option.tenantId === tenantId) ?? [];
  const breakdowns = [
    ...(showTenantFilter ? [{ title: '按租户消耗', rows: data?.tokens.byTenant ?? [] }] : []),
    ...(showUserFilter ? [{ title: '按用户消耗', rows: data?.tokens.byUser ?? [] }] : []),
    { title: '按空间消耗', rows: data?.tokens.bySpace ?? [] },
    { title: '按模型消耗', rows: data?.tokens.byModel ?? [] },
  ];

  return (
    <div className="grid h-full min-h-0 min-w-0 content-start gap-4 overflow-y-auto pr-1" aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(rangeDays)} onValueChange={(value) => changeFilter(() => setRangeDays(Number(value)))}>
          <SelectTrigger className="w-36" aria-label="统计时间范围"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="30">最近 30 天</SelectItem><SelectItem value="84">最近 12 周</SelectItem><SelectItem value="365">最近一年</SelectItem></SelectContent>
        </Select>
        {showTenantFilter && (
          <Select value={tenantId} onValueChange={(value) => changeFilter(() => { setTenantId(value); setUserId('all'); setSpaceId('all'); })}>
            <SelectTrigger className="w-52" aria-label="租户筛选"><SelectValue placeholder="全部租户" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部租户</SelectItem>{options?.tenants.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {showUserFilter && (
          <Select value={userId} onValueChange={(value) => changeFilter(() => { setUserId(value); setSpaceId('all'); })}>
            <SelectTrigger className="w-52" aria-label="用户筛选"><SelectValue placeholder="全部用户" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部用户</SelectItem>{users.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <Select value={spaceId} onValueChange={(value) => changeFilter(() => setSpaceId(value))}>
          <SelectTrigger className="w-52" aria-label="空间筛选"><SelectValue placeholder="全部空间" /></SelectTrigger>
          <SelectContent><SelectItem value="all">全部空间</SelectItem>{spaces.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void refresh(view === 'storage' && Boolean(refreshStorage))} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          {view === 'storage' && refreshStorage ? '重新扫描' : '刷新'}
        </Button>
        {loading && <span role="status" className="text-sm text-muted-foreground">正在读取{view === 'storage' ? '存储' : '用量'}…</span>}
        {message && <span role="alert" className="text-sm text-destructive">{message}</span>}
      </div>

      {view === 'usage' ? <>
        <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>有效 Token</CardDescription><CardTitle>{formatMetric(data?.tokens.totals.effectiveTokens ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">成功请求的输入与输出</CardContent></Card>
          <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>尝试 Token</CardDescription><CardTitle>{formatMetric(data?.tokens.totals.attemptedTokens ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">包含失败和重试，共 {formatMetric(data?.tokens.totals.attempts ?? 0)} 次尝试</CardContent></Card>
          <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>缓存输入</CardDescription><CardTitle>{formatMetric(data?.tokens.totals.cachedInputTokens ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">属于输入 Token 的缓存部分</CardContent></Card>
        </div>
        <Card className="min-w-0 rounded-lg shadow-sm">
          <CardHeader><CardTitle>每日 Token</CardTitle><CardDescription>按实际模型请求日期（北京时间）记录；输入与输出包含失败、重试，缓存输入是输入的子集，不重复相加。拖动底部滑块缩放日期，点击图例切换序列。</CardDescription></CardHeader>
          <CardContent className="min-w-0"><DailyTokenChart data={data} /></CardContent>
        </Card>
        {breakdowns.map(({ title, rows }) => (
          <Card key={title} className="min-w-0 rounded-lg shadow-sm">
            <CardHeader><CardTitle>{title}</CardTitle><CardDescription>展示全部项目的输入与输出；悬浮查看精确输入、输出、缓存、有效和尝试 Token 及尝试次数。超过 12 项时拖动右侧滑块或在图内滚动查看，点击图例切换序列。</CardDescription></CardHeader>
            <CardContent className="min-w-0"><TokenBreakdownChart rows={rows} label={title} /></CardContent>
          </Card>
        ))}
      </> : <>
        <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>逻辑大小</CardDescription><CardTitle title={`${formatMetric(data?.storage.totals.logicalBytes ?? 0)} 字节`}>{formatBytes(data?.storage.totals.logicalBytes ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{data?.storage.capturedAt ? `${shanghaiTime(data.storage.capturedAt)}（北京时间）` : '等待扫描'}</CardContent></Card>
          <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>磁盘分配</CardDescription><CardTitle title={`${formatMetric(data?.storage.totals.allocatedBytes ?? 0)} 字节`}>{formatBytes(data?.storage.totals.allocatedBytes ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">实际分配大小，不与逻辑大小相加</CardContent></Card>
          <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>文件</CardDescription><CardTitle>{formatMetric(data?.storage.totals.fileCount ?? 0)}</CardTitle></CardHeader></Card>
          <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>符号链接</CardDescription><CardTitle>{formatMetric(data?.storage.totals.symlinkCount ?? 0)}</CardTitle></CardHeader></Card>
        </div>
        <Card className="min-w-0 rounded-lg shadow-sm">
          <CardHeader><CardTitle>按空间占用</CardTitle><CardDescription>展示全部空间，用户文件与其他非空间存储（如租户共享数据）独立列出，不归入任意空间。悬浮查看精确字节、文件和链接数量；超过 12 项时拖动右侧滑块或在图内滚动查看全部项目。</CardDescription></CardHeader>
          <CardContent className="min-w-0"><StorageSpaceChart data={data} /></CardContent>
        </Card>
        <Card className="min-w-0 rounded-lg shadow-sm">
          <CardHeader><CardTitle>存储趋势</CardTitle><CardDescription>每日采样桶的逻辑大小与磁盘分配；北京时间展示。缺少样本的日期保留断点，不补零、不跨缺样连线。</CardDescription></CardHeader>
          <CardContent className="min-w-0"><StorageHistoryChart data={data} /></CardContent>
        </Card>
        <Card className="min-w-0 rounded-lg shadow-sm">
          <CardHeader><CardTitle>存储分类对比</CardTitle><CardDescription>最新扫描的逻辑大小和磁盘分配，不相加；悬浮查看精确字节数，点击图例切换序列。</CardDescription></CardHeader>
          <CardContent className="min-w-0"><StorageCategoryChart rows={data?.storage.byCategory ?? []} /></CardContent>
        </Card>
      </>}
    </div>
  );
}
