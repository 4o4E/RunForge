import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import type { TaskTokenUsagePoint, UsageAggregateResponse } from '@runforge/contracts';
import type { UsageQuery } from '@/usageApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { UsageChart, dateZoom, formatMetric, shanghaiTime, tooltipIndex, tooltipRows, usageDates } from './UsageChart';

interface SpaceTaskUsagePanelProps {
  spaceId: string;
  load: (query: UsageQuery) => Promise<UsageAggregateResponse>;
}

function formatRate(value: number | null | undefined): string {
  return value == null ? '不可用（无输入 Token）' : `${formatMetric(value * 100)}%`;
}

function taskTooltip(date: string, point: TaskTokenUsagePoint | undefined): string {
  return tooltipRows(`${date} 发起的任务（北京时间）`, [
    ['任务数', formatMetric(point?.taskCount ?? 0)],
    ['累计 Token', formatMetric(point?.totalTokens ?? 0)],
    ['输入', formatMetric(point?.inputTokens ?? 0)],
    ['输出', formatMetric(point?.outputTokens ?? 0)],
    ['缓存输入（输入子集）', formatMetric(point?.cachedInputTokens ?? 0)],
    ['每任务平均', point?.taskCount ? point.averageTokens.toLocaleString('zh-CN', { maximumFractionDigits: 20 }) : '暂无任务'],
    ['单任务最大', point?.taskCount ? formatMetric(point.maxTokens) : '暂无任务'],
    ['单任务最小', point?.taskCount ? formatMetric(point.minTokens) : '暂无任务'],
    ['缓存率', formatRate(point?.cacheRate)],
  ]);
}

export function SpaceTaskUsagePanel({ spaceId, load }: SpaceTaskUsagePanelProps) {
  const [rangeDays, setRangeDays] = useState(30);
  const [data, setData] = useState<UsageAggregateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setMessage('');
    try {
      const result = await load({ spaceId, rangeDays });
      if (request === sequence.current) setData(result);
    } catch (error) {
      if (request === sequence.current) setMessage(`读取任务用量失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [load, rangeDays, spaceId]);

  useEffect(() => {
    setData(null);
    void refresh();
    return () => { sequence.current += 1; };
  }, [refresh]);

  const charts = useMemo(() => {
    const dates = usageDates(data?.filters);
    const byDate = new Map(data?.tasks.daily.map((point) => [point.date, point]));
    const points = dates.map((date) => byDate.get(date));
    const base: EChartsOption = {
      xAxis: { type: 'category', data: dates, boundaryGap: true, axisLabel: { hideOverlap: true } },
      dataZoom: dateZoom,
      tooltip: { formatter: (params) => {
        const index = tooltipIndex(params);
        return dates[index] ? taskTooltip(dates[index], points[index]) : '';
      } },
    };
    const totals: EChartsOption = {
      ...base,
      grid: { top: 50, right: 24, bottom: 64, left: 16, containLabel: true },
      yAxis: [
        { type: 'value', name: '累计 Token', axisLabel: { formatter: (value: number) => formatMetric(value) } },
        { type: 'value', name: '任务数', minInterval: 1, splitLine: { show: false } },
      ],
      series: [
        { name: '任务累计输入', type: 'bar', stack: 'tokens', barMaxWidth: 28, data: points.map((point) => point?.inputTokens ?? 0) },
        { name: '任务累计输出', type: 'bar', stack: 'tokens', barMaxWidth: 28, data: points.map((point) => point?.outputTokens ?? 0) },
        { name: '任务数', type: 'line', yAxisIndex: 1, showSymbol: false, data: points.map((point) => point?.taskCount ?? 0) },
      ],
    };
    const perTask: EChartsOption = {
      ...base,
      yAxis: { type: 'value', name: 'Token / 任务', axisLabel: { formatter: (value: number) => formatMetric(value) } },
      series: [
        { name: '每任务平均', type: 'line', showSymbol: true, symbolSize: 5, connectNulls: false, data: points.map((point) => point?.taskCount ? point.averageTokens : null) },
        { name: '单任务最大', type: 'line', showSymbol: true, symbolSize: 5, connectNulls: false, data: points.map((point) => point?.taskCount ? point.maxTokens : null) },
        { name: '单任务最小', type: 'line', showSymbol: true, symbolSize: 5, connectNulls: false, data: points.map((point) => point?.taskCount ? point.minTokens : null) },
      ],
    };
    const cache: EChartsOption = {
      ...base,
      yAxis: { type: 'value', name: '缓存率', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      series: [{ name: '缓存输入 / 输入', type: 'line', showSymbol: true, symbolSize: 5, connectNulls: false, data: points.map((point) => point?.cacheRate == null ? null : point.cacheRate * 100) }],
    };
    return { totals, perTask, cache };
  }, [data]);

  const totals = data?.tasks.totals;
  const noTasks = !totals?.taskCount;
  const noCache = !data?.tasks.daily.some((point) => point.cacheRate !== null);

  return (
    <section className="grid min-w-0 gap-4" aria-label="空间任务 Token 用量" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="font-medium">空间任务用量</h3><p className="text-xs text-muted-foreground">按任务发起日期统计累计消耗，包含全部子任务。</p></div>
        <div className="flex items-center gap-2">
          <Select value={String(rangeDays)} onValueChange={(value) => setRangeDays(Number(value))}>
            <SelectTrigger className="w-36" aria-label="任务创建日期范围"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="30">最近 30 天</SelectItem><SelectItem value="84">最近 12 周</SelectItem><SelectItem value="365">最近一年</SelectItem></SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} />刷新</Button>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">每次发起的运行独立计算一个任务，正常续聊按各自发起日期分别统计；运行中的补充输入属于原任务。按北京时间的发起日期累计已记录的主 Agent、子 Agent、失败和重试用量，跨日消耗仍计入该任务发起日。零用量任务参与平均、最大和最小值计算，缓存率为缓存输入占全部输入的比例。</p>
      {data && <p className="text-xs text-muted-foreground">任务发起范围：{shanghaiTime(data.filters.from)} 至 {shanghaiTime(data.filters.to)}（北京时间）；统计截止：{shanghaiTime(data.filters.to)}。</p>}
      {message && <p className="text-sm text-destructive" role="alert">{message}</p>}
      {loading && <p className="text-xs text-muted-foreground" role="status">正在读取任务用量…</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardDescription>任务累计 Token</CardDescription><CardTitle>{totals ? formatMetric(totals.totalTokens) : '—'}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">包含子任务、失败与重试</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardDescription>任务数</CardDescription><CardTitle>{totals ? formatMetric(totals.taskCount) : '—'}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">每次发起分别计数，包含零用量任务</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardDescription>每任务平均 Token</CardDescription><CardTitle>{totals ? noTasks ? '暂无任务' : formatMetric(totals.averageTokens) : '—'}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">累计 Token ÷ 任务数</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardDescription>输入缓存率</CardDescription><CardTitle>{totals ? totals.cacheRate == null ? '不可用' : formatRate(totals.cacheRate) : '—'}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{!totals ? '待读取任务用量' : totals.cacheRate == null ? '无输入 Token，不能计算缓存率' : `缓存输入 ${formatMetric(totals.cachedInputTokens)} / 输入 ${formatMetric(totals.inputTokens)}`}</CardContent></Card>
      </div>
      <Card className="min-w-0"><CardHeader><CardTitle className="text-base">每日发起任务的累计 Token</CardTitle><CardDescription>柱形为当日发起任务的累计输入、输出，折线为任务数量；悬浮查看详情，拖动底部滑块缩放日期。</CardDescription></CardHeader><CardContent className="min-w-0"><UsageChart option={charts.totals} label="按任务发起日期汇总的累计输入输出和任务数量" empty={noTasks} emptyText={loading ? '正在读取…' : data ? '所选日期没有任务' : '任务用量尚未读取'} height={340} /></CardContent></Card>
      <Card className="min-w-0"><CardHeader><CardTitle className="text-base">每任务 Token 分布</CardTitle><CardDescription>每日发起任务的平均、最大、最小累计 Token；没有任务的日期留空。</CardDescription></CardHeader><CardContent className="min-w-0"><UsageChart option={charts.perTask} label="每日发起任务的平均最大最小 Token" empty={noTasks} emptyText={loading ? '正在读取…' : data ? '所选日期没有任务' : '任务用量尚未读取'} height={320} /></CardContent></Card>
      <Card className="min-w-0"><CardHeader><CardTitle className="text-base">每日任务输入缓存率</CardTitle><CardDescription>每日发起任务的缓存输入 ÷ 输入 Token；无输入的日期留空。</CardDescription></CardHeader><CardContent className="min-w-0"><UsageChart option={charts.cache} label="每日发起任务的输入缓存率" empty={noCache} emptyText={loading ? '正在读取…' : data ? '无输入 Token，缓存率不可用' : '任务用量尚未读取'} height={300} /></CardContent></Card>
    </section>
  );
}
