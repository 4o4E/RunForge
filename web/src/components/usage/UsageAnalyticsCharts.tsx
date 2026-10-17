import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import type { StorageUsageBreakdown, TokenUsageTotals, UsageAggregateResponse } from '@runforge/contracts';
import { UsageChart, dateZoom, exactBytes, formatBytes, formatMetric, shanghaiDate, shanghaiTime, tooltipIndex, tooltipRows, usageDates } from './UsageChart';

export const CATEGORY_LABELS: Record<string, string> = {
  thread_uploads: '会话上传文件',
  thread_agent_runtime: 'Agent 运行目录',
  thread_plugins: '会话插件入口',
  thread_workspace: '会话工作目录',
  external_artifacts: '外部调用产物',
  business_plugin_current: '业务插件当前版本',
  business_plugin_snapshots: '业务插件历史快照',
  database_logical: '数据库逻辑数据',
};

function tokenTooltip(title: string, row: TokenUsageTotals | undefined): string {
  return tooltipRows(title, [
    ['尝试 Token', formatMetric(row?.attemptedTokens ?? 0)],
    ['有效 Token', formatMetric(row?.effectiveTokens ?? 0)],
    ['输入', formatMetric(row?.inputTokens ?? 0)],
    ['输出', formatMetric(row?.outputTokens ?? 0)],
    ['缓存输入（包含在输入中）', formatMetric(row?.cachedInputTokens ?? 0)],
    ['模型尝试', formatMetric(row?.attempts ?? 0)],
    ['未返回用量的尝试', formatMetric(row?.attemptsWithoutUsage ?? 0)],
  ]);
}

export function DailyTokenChart({ data }: { data: UsageAggregateResponse | null }) {
  const option = useMemo<EChartsOption>(() => {
    const dates = usageDates(data?.filters);
    const byDate = new Map(data?.tokens.daily.map((point) => [point.date, point]));
    return {
      xAxis: { type: 'category', data: dates, axisLabel: { hideOverlap: true }, boundaryGap: true },
      yAxis: { type: 'value', name: 'Token', axisLabel: { formatter: (value: number) => formatMetric(value) } },
      dataZoom: dateZoom,
      tooltip: { formatter: (params) => {
        const date = dates[tooltipIndex(params)];
        return date ? tokenTooltip(`${date}（北京时间）`, byDate.get(date)) : '';
      } },
      series: [
        { name: '输入', type: 'bar', stack: 'tokens', barMaxWidth: 28, data: dates.map((date) => byDate.get(date)?.inputTokens ?? 0) },
        { name: '输出', type: 'bar', stack: 'tokens', barMaxWidth: 28, data: dates.map((date) => byDate.get(date)?.outputTokens ?? 0) },
        { name: '缓存输入（输入子集）', type: 'line', showSymbol: false, data: dates.map((date) => byDate.get(date)?.cachedInputTokens ?? 0) },
        { name: '有效 Token', type: 'line', showSymbol: false, data: dates.map((date) => byDate.get(date)?.effectiveTokens ?? 0) },
      ],
    };
  }, [data]);
  return <UsageChart option={option} label="每日实际 Token 消耗，输入输出堆叠柱形与缓存、有效 Token 折线" empty={!data || data.tokens.daily.length === 0} height={360} />;
}

export function ModelUsageChart({ data }: { data: UsageAggregateResponse | null }) {
  const rows = data?.tokens.byModel ?? [];
  const option = useMemo<EChartsOption>(() => ({
    grid: { top: 48, bottom: 36, left: 12, right: rows.length > 12 ? 48 : 24, containLabel: true },
    xAxis: { type: 'value', name: 'Token', axisLabel: { formatter: (value: number) => formatMetric(value) } },
    yAxis: { type: 'category', inverse: true, data: rows.map((row) => row.label), axisLabel: { width: 180, overflow: 'truncate', fontSize: 11 } },
    dataZoom: rows.length > 12 ? [
      { type: 'slider', yAxisIndex: 0, right: 2, width: 20, startValue: 0, endValue: 11, filterMode: 'none' },
      { type: 'inside', yAxisIndex: 0, startValue: 0, endValue: 11, filterMode: 'none', zoomOnMouseWheel: false, moveOnMouseWheel: true },
    ] : [],
    tooltip: { axisPointer: { type: 'shadow' }, formatter: (params) => {
      const row = rows[tooltipIndex(params)];
      return row ? tokenTooltip(row.label, row) : '';
    } },
    series: [
      { name: '输入', type: 'bar', stack: 'tokens', barMaxWidth: 26, data: rows.map((row) => row.inputTokens) },
      { name: '输出', type: 'bar', stack: 'tokens', barMaxWidth: 26, data: rows.map((row) => row.outputTokens) },
    ],
  }), [rows]);
  return <UsageChart option={option} label="所有供应商与模型的实际 Token 消耗，可拖动右侧缩放条查看全部模型" empty={rows.length === 0} height={Math.max(300, Math.min(12, rows.length) * 34 + 90)} />;
}

export function StorageHistoryChart({ data }: { data: UsageAggregateResponse | null }) {
  const option = useMemo<EChartsOption>(() => {
    const dates = usageDates(data?.filters);
    const byDate = new Map(data?.storage.history.map((point) => [shanghaiDate(point.at), point]));
    return {
      xAxis: { type: 'category', data: dates, boundaryGap: false, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: '大小', axisLabel: { formatter: (value: number) => formatBytes(value) } },
      dataZoom: dateZoom,
      tooltip: { formatter: (params) => {
        const date = dates[tooltipIndex(params)];
        const point = byDate.get(date);
        if (!date) return '';
        return point ? tooltipRows(`${date}（北京时间）`, [
          ['逻辑大小', exactBytes(point.logicalBytes)], ['磁盘分配', exactBytes(point.allocatedBytes)],
          ['文件', formatMetric(point.fileCount)], ['符号链接', formatMetric(point.symlinkCount)],
          ['采样桶起点', `${shanghaiTime(point.at)}（北京时间）`],
        ]) : tooltipRows(date, [['存储采样', '缺少样本（不是零占用）']]);
      } },
      series: [
        { name: '逻辑大小', type: 'line', connectNulls: false, showSymbol: true, symbolSize: 5, data: dates.map((date) => byDate.get(date)?.logicalBytes ?? null) },
        { name: '磁盘分配', type: 'line', connectNulls: false, showSymbol: true, symbolSize: 5, data: dates.map((date) => byDate.get(date)?.allocatedBytes ?? null) },
      ],
    };
  }, [data]);
  return <UsageChart option={option} label="存储逻辑大小与磁盘分配历史，缺少采样的日期保留断点" empty={!data || data.storage.history.length === 0} emptyText="等待首次存储日样本" />;
}

export function StorageCategoryChart({ rows }: { rows: StorageUsageBreakdown[] }) {
  const option = useMemo<EChartsOption>(() => ({
    grid: { top: 48, bottom: 30, left: 12, right: 24, containLabel: true },
    xAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatBytes(value) } },
    yAxis: { type: 'category', inverse: true, data: rows.map((row) => CATEGORY_LABELS[row.id] ?? row.label), axisLabel: { width: 160, overflow: 'truncate', fontSize: 11 } },
    tooltip: { axisPointer: { type: 'shadow' }, formatter: (params) => {
      const row = rows[tooltipIndex(params)];
      return row ? tooltipRows(CATEGORY_LABELS[row.id] ?? row.label, [
        ['逻辑大小', exactBytes(row.logicalBytes)], ['磁盘分配', exactBytes(row.allocatedBytes)],
        ['文件', formatMetric(row.fileCount)], ['符号链接', formatMetric(row.symlinkCount)],
      ]) : '';
    } },
    series: [
      { name: '逻辑大小', type: 'bar', barMaxWidth: 18, data: rows.map((row) => row.logicalBytes) },
      { name: '磁盘分配', type: 'bar', barMaxWidth: 18, data: rows.map((row) => row.allocatedBytes) },
    ],
  }), [rows]);
  return <UsageChart option={option} label="各存储分类的逻辑大小和磁盘分配比较" empty={rows.length === 0} emptyText="等待首次存储扫描" height={Math.max(300, rows.length * 46 + 80)} />;
}
