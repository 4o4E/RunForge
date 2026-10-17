import { useEffect, useRef } from 'react';
import { init, use, type EChartsType } from 'echarts/core';
import type { DataZoomComponentOption, EChartsOption } from 'echarts';
import { BarChart, LineChart } from 'echarts/charts';
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useThemeCtx } from '@/theme';

use([BarChart, LineChart, AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export const CHART_COLORS = ['#3b82f6', '#22b8a7', '#f59e0b', '#a78bfa', '#f472b6', '#ef6464'];

export function formatMetric(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${formatMetric(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function exactBytes(value: number): string {
  return `${formatBytes(value)}（${formatMetric(value)} 字节）`;
}

export function shanghaiDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
}

export function shanghaiTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export function usageDates(filters: { from: string; to: string } | undefined): string[] {
  if (!filters) return [];
  const start = Date.parse(`${shanghaiDate(filters.from)}T00:00:00+08:00`);
  const last = shanghaiDate(new Date(Date.parse(filters.to) - 1));
  const end = Date.parse(`${last}T00:00:00+08:00`);
  return Array.from({ length: Math.max(0, Math.floor((end - start) / 86_400_000) + 1) }, (_, index) => (
    shanghaiDate(new Date(start + index * 86_400_000))
  ));
}

const TOOLTIP_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// 原生 HTML tooltip 必须转义服务端返回的模型名和分类名。
export function escapeTooltip(value: string): string {
  return value.replace(/[&<>"']/g, (character) => TOOLTIP_ESCAPES[character]!);
}

export function tooltipRows(title: string, rows: Array<[string, string]>): string {
  return `<strong>${escapeTooltip(title)}</strong>${rows.map(([label, value]) => `<div>${escapeTooltip(label)}：${escapeTooltip(value)}</div>`).join('')}`;
}

export function tooltipIndex(params: unknown): number {
  const item = Array.isArray(params) ? params[0] : params;
  return (item as { dataIndex?: number } | undefined)?.dataIndex ?? -1;
}

export const dateZoom: DataZoomComponentOption[] = [
  { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl' },
  { type: 'slider', xAxisIndex: 0, bottom: 4, height: 22, filterMode: 'none' },
];

export function UsageChart({ option, label, empty = false, emptyText = '当前范围暂无数据', height = 340 }: {
  option: EChartsOption;
  label: string;
  empty?: boolean;
  emptyText?: string;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const { theme } = useThemeCtx();
  const instance = useRef<EChartsType | null>(null);

  useEffect(() => {
    if (!container.current || empty) return;
    const chart = init(container.current, theme === 'dark' ? 'dark' : undefined, { renderer: 'canvas' });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.current = null;
      chart.dispose();
    };
  }, [empty, theme]);

  useEffect(() => {
    const dark = theme === 'dark';
    instance.current?.setOption({
      animation: false,
      backgroundColor: 'transparent',
      color: CHART_COLORS,
      textStyle: { color: dark ? '#e2e8f0' : '#334155', fontFamily: 'inherit' },
      aria: { enabled: true, label: { description: label } },
      legend: { top: 0, type: 'scroll', textStyle: { color: dark ? '#cbd5e1' : '#475569' } },
      grid: { top: 50, right: 24, bottom: 64, left: 16, containLabel: true },
      ...option,
      tooltip: {
        trigger: 'axis', confine: true,
        backgroundColor: dark ? '#18181b' : '#ffffff',
        borderColor: dark ? '#52525b' : '#e2e8f0',
        textStyle: { color: dark ? '#f4f4f5' : '#18181b', fontSize: 12 },
        extraCssText: 'max-width: min(480px, 85vw); white-space: normal; overflow-wrap: anywhere;',
        ...(!Array.isArray(option.tooltip) ? option.tooltip : {}),
      },
    }, { notMerge: true });
  }, [empty, label, option, theme]);

  return empty ? (
    <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }} role="status">{emptyText}</div>
  ) : <div ref={container} className="w-full min-w-0" style={{ height }} role="img" aria-label={label} />;
}
