import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { StorageUsageBreakdown, TokenUsageBreakdown, UsageAggregateResponse } from '@runforge/contracts';
import type { UsageQuery } from '@/usageApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatBytes, formatMetric, shanghaiTime } from './UsageChart';
import { CATEGORY_LABELS, DailyTokenChart, ModelUsageChart, StorageCategoryChart, StorageHistoryChart } from './UsageAnalyticsCharts';

interface UsageAnalyticsPanelProps {
  load: (query: UsageQuery) => Promise<UsageAggregateResponse>;
  showTenantFilter?: boolean;
  showUserFilter?: boolean;
  refreshStorage?: () => Promise<void>;
}

function TokenBreakdownTable({ title, rows }: { title: string; rows: TokenUsageBreakdown[] }) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>项目</TableHead><TableHead className="text-right">输入</TableHead><TableHead className="text-right">输出</TableHead><TableHead className="text-right">缓存输入</TableHead><TableHead className="text-right">有效 Token</TableHead><TableHead className="text-right">尝试 Token</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.tenantId ?? ''}:${row.id}`}>
                <TableCell className="max-w-64 truncate" title={row.label}>{row.label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.inputTokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.outputTokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.cachedInputTokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.effectiveTokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetric(row.attemptedTokens)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>}
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

  useEffect(() => {
    setData(null);
    void refresh();
    return () => { requestSequence.current += 1; };
  }, [refresh]);

  const options = data?.options;
  const users = options?.users.filter((option) => tenantId === 'all' || option.tenantId === tenantId) ?? [];
  const spaces = options?.spaces.filter((option) => tenantId === 'all' || option.tenantId === tenantId) ?? [];

  return (
    <div className="grid h-full min-h-0 min-w-0 content-start gap-4 overflow-y-auto pr-1">
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
        <Card className="rounded-lg shadow-sm"><CardHeader className="pb-2"><CardDescription>当前存储</CardDescription><CardTitle>{formatBytes(data?.storage.totals.logicalBytes ?? 0)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">磁盘分配 {formatBytes(data?.storage.totals.allocatedBytes ?? 0)} · {data?.storage.capturedAt ? `${shanghaiTime(data.storage.capturedAt)}（北京时间）` : '等待扫描'}</CardContent></Card>
      </div>

      <Card className="rounded-lg shadow-sm">
        <CardHeader><CardTitle>每日 Token</CardTitle><CardDescription>按实际模型请求日期（北京时间）记录；输入与输出包含失败、重试，缓存输入是输入的子集，不重复相加。拖动底部滑块缩放日期，点击图例切换序列。</CardDescription></CardHeader>
        <CardContent className="min-w-0"><DailyTokenChart data={data} /></CardContent>
      </Card>

      <Card className="min-w-0 rounded-lg shadow-sm">
        <CardHeader><CardTitle>按模型消耗</CardTitle><CardDescription>全部供应商与模型的输入、输出 Token；超过 12 项时拖动右侧滑块或在图内滚动查看，明细表保留全部项目。</CardDescription></CardHeader>
        <CardContent className="min-w-0"><ModelUsageChart data={data} /></CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {showTenantFilter && <TokenBreakdownTable title="按租户" rows={data?.tokens.byTenant ?? []} />}
        {showUserFilter && <TokenBreakdownTable title="按用户" rows={data?.tokens.byUser ?? []} />}
        <TokenBreakdownTable title="按空间" rows={data?.tokens.bySpace ?? []} />
        <TokenBreakdownTable title="按模型" rows={data?.tokens.byModel ?? []} />
      </div>
      <Card className="rounded-lg shadow-sm">
        <CardHeader><CardTitle>存储趋势</CardTitle><CardDescription>每日采样桶的逻辑大小与磁盘分配；北京时间展示。缺少样本的日期保留断点，不补零、不跨缺样连线。</CardDescription></CardHeader>
        <CardContent className="min-w-0"><StorageHistoryChart data={data} /></CardContent>
      </Card>
      <Card className="min-w-0 rounded-lg shadow-sm">
        <CardHeader><CardTitle>存储分类对比</CardTitle><CardDescription>最新扫描的逻辑大小和磁盘分配，不相加；悬浮查看精确字节数。</CardDescription></CardHeader>
        <CardContent className="min-w-0"><StorageCategoryChart rows={data?.storage.byCategory ?? []} /></CardContent>
      </Card>
      <StorageBreakdownTable rows={data?.storage.byCategory ?? []} />
    </div>
  );
}
