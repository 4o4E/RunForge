import { useMemo, useState } from 'react';
import { parseDelimitedText } from '@/delimitedText';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PAGE_SIZE = 100;
const COLUMN_PAGE_SIZE = 20;

export function DelimitedTextPreview({ source, format }: { source: string; format: 'csv' | 'tsv' }) {
  // CSV 使用逗号、TSV 使用制表符；不推断表头或转换数字，保留前导零和原始单元格内容。
  const parsed = useMemo(() => parseDelimitedText(source, format), [source, format]);
  const columnCount = useMemo(() => parsed.data.reduce((count, row) => Math.max(count, row.length), 0), [parsed]);
  const [pageIndex, setPageIndex] = useState(0);
  const [columnPageIndex, setColumnPageIndex] = useState(0);
  const columnPageCount = Math.max(1, Math.ceil(columnCount / COLUMN_PAGE_SIZE));
  const columnPage = Math.min(columnPageIndex, columnPageCount - 1);
  const firstColumn = columnPage * COLUMN_PAGE_SIZE;
  const columnEnd = Math.min(firstColumn + COLUMN_PAGE_SIZE, columnCount);
  // 行列分别分页，宽表格也只创建当前窗口的单元格，所有字段仍可通过翻页查看。
  const columns = useMemo(() => Array.from({ length: columnEnd - firstColumn }, (_, index) => firstColumn + index), [firstColumn, columnEnd]);
  const pageCount = Math.max(1, Math.ceil(parsed.data.length / PAGE_SIZE));
  const page = Math.min(pageIndex, pageCount - 1);
  const firstRow = page * PAGE_SIZE;
  const rows = parsed.data.slice(firstRow, firstRow + PAGE_SIZE);
  const error = parsed.errors[0];

  if (error) return <div role="alert" className="rounded-md border border-destructive/30 p-4 text-sm text-destructive">表格解析失败{error.row == null ? '' : `（第 ${error.row + 1} 条记录）`}：{error.message}</div>;
  if (!parsed.data.length) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">空表格</div>;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-background">
      <div className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">{format.toUpperCase()} · {parsed.data.length.toLocaleString('zh-CN')} 条记录 · {columnCount.toLocaleString('zh-CN')} 列</div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="w-max min-w-full" aria-label={`${format.toUpperCase()} 表格预览`}>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 w-12 whitespace-nowrap bg-muted text-right">序号</TableHead>
              {columns.map((index) => <TableHead key={index} className="whitespace-nowrap bg-muted">第 {index + 1} 列</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => <TableRow key={firstRow + index}>
              <TableCell className="sticky left-0 bg-background text-right text-xs tabular-nums text-muted-foreground">{firstRow + index + 1}</TableCell>
              {columns.map((column) => <TableCell key={column} className="max-w-96 whitespace-pre-wrap break-words align-top" title={row[column]}>{row[column] ?? ''}</TableCell>)}
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
      {(pageCount > 1 || columnPageCount > 1) && <div className="flex shrink-0 flex-col gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        {pageCount > 1 && <div className="flex flex-wrap items-center justify-between gap-2">
          <span>第 {firstRow + 1}–{Math.min(firstRow + PAGE_SIZE, parsed.data.length)} 条记录 · 第 {page + 1}/{pageCount} 页</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={page === pageCount - 1} onClick={() => setPageIndex(page + 1)}>下一页</Button>
          </div>
        </div>}
        {columnPageCount > 1 && <div className="flex flex-wrap items-center justify-between gap-2">
          <span>第 {firstColumn + 1}–{columnEnd} 列 · 第 {columnPage + 1}/{columnPageCount} 组</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={columnPage === 0} onClick={() => setColumnPageIndex(columnPage - 1)}>上一组列</Button>
            <Button size="sm" variant="outline" disabled={columnPage === columnPageCount - 1} onClick={() => setColumnPageIndex(columnPage + 1)}>下一组列</Button>
          </div>
        </div>}
      </div>}
    </div>
  );
}
