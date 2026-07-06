import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { Menu, Search } from 'lucide-react';
import { searchThreads, type ThreadSearchResult } from '@/api';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  threadHref: (threadId: string) => string;
  onOpenThread: (threadId: string) => void;
  mobile?: boolean;
  onOpenMobileSidebar?: () => void;
}

interface ThreadGroup {
  threadId: string;
  title: string;
  latestAt: string;
  results: ThreadSearchResult[];
}

interface SnippetBlock {
  startLine: number;
  endLine: number;
  text: string;
  hasPrefix: boolean;
  hasSuffix: boolean;
}

const ROLE_LABELS: Record<ThreadSearchResult['role'], string> = {
  user: '用户',
  assistant: '助手',
};

function searchParam(): string {
  return new URLSearchParams(window.location.search).get('q') ?? '';
}

function threadTitle(result: ThreadSearchResult): string {
  return result.thread_title?.trim() || `会话 ${result.thread_id.slice(0, 8)}`;
}

function resultSnippetBlocks(content: string, query: string): SnippetBlock[] {
  const text = content.replace(/\r\n?/g, '\n');
  if (!text.trim()) {
    return [{ startLine: 0, endLine: 0, text: '（空内容）', hasPrefix: false, hasSuffix: false }];
  }
  const lines = text.split('\n');
  const needle = query.trim().toLowerCase();
  const hitLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => needle && line.toLowerCase().includes(needle))
    .map(({ index }) => index);

  if (!hitLines.length) {
    const endLine = Math.min(lines.length - 1, 4);
    return [{
      startLine: 0,
      endLine,
      text: lines.slice(0, endLine + 1).join('\n'),
      hasPrefix: false,
      hasSuffix: endLine < lines.length - 1,
    }];
  }

  const windows = hitLines.map((line) => ({
    startLine: Math.max(0, line - 2),
    endLine: Math.min(lines.length - 1, line + 2),
  }));
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.startLine <= previous.endLine + 2) {
      previous.endLine = Math.max(previous.endLine, window.endLine);
    } else {
      merged.push({ ...window });
    }
  }

  return merged.map((block) => ({
    ...block,
    text: lines.slice(block.startLine, block.endLine + 1).join('\n'),
    hasPrefix: block.startLine > 0,
    hasSuffix: block.endLine < lines.length - 1,
  }));
}

function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const needle = query.trim();
  if (!needle) return [{ text, hit: false }];
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (;;) {
    const index = lowerText.indexOf(lowerNeedle, cursor);
    if (index < 0) break;
    if (index > cursor) parts.push({ text: text.slice(cursor, index), hit: false });
    parts.push({ text: text.slice(index, index + needle.length), hit: true });
    cursor = index + needle.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

function groupResults(results: ThreadSearchResult[]): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const result of results) {
    const existing = groups.get(result.thread_id);
    if (existing) {
      existing.results.push(result);
      if (new Date(result.created_at).getTime() > new Date(existing.latestAt).getTime()) existing.latestAt = result.created_at;
      continue;
    }
    groups.set(result.thread_id, {
      threadId: result.thread_id,
      title: threadTitle(result),
      latestAt: result.created_at,
      results: [result],
    });
  }
  return [...groups.values()].sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime());
}

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function shouldHandleAppLink(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

export function SearchView({ threadHref, onOpenThread, mobile = false, onOpenMobileSidebar }: Props) {
  const [query, setQuery] = useState(searchParam);
  const [results, setResults] = useState<ThreadSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const trimmedQuery = query.trim();
  const groups = useMemo(() => groupResults(results), [results]);

  useEffect(() => {
    const next = searchParam();
    setQuery(next);
  }, []);

  useEffect(() => {
    const path = trimmedQuery ? `/search?q=${encodeURIComponent(trimmedQuery)}` : '/search';
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.replaceState(null, '', path);
    }
  }, [trimmedQuery]);

  useEffect(() => {
    if (!trimmedQuery) {
      setResults([]);
      setError('');
      setLoading(false);
      return;
    }
    let canceled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError('');
      searchThreads(trimmedQuery)
        .then((data) => {
          if (!canceled) setResults(data.results);
        })
        .catch((err) => {
          if (!canceled) setError((err as Error).message);
        })
        .finally(() => {
          if (!canceled) setLoading(false);
        });
    }, 180);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedQuery]);

  const statusText = useMemo(() => {
    if (!trimmedQuery) return '输入关键词搜索所有会话内容';
    if (loading) return '搜索中...';
    if (error) return `搜索失败：${error}`;
    return `找到 ${groups.length} 个会话，${results.length} 条结果`;
  }, [error, groups.length, loading, results.length, trimmedQuery]);

  return (
    <main className="app-main-surface flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {mobile && (
        <header className="app-topbar-surface flex h-14 shrink-0 items-center border-b px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mr-1 size-9 shrink-0"
            onClick={onOpenMobileSidebar}
            title="打开会话列表"
          >
            <Menu className="size-4" />
          </Button>
          <h1 className="truncate text-sm font-semibold">搜索</h1>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-3 py-4 md:px-6 md:py-5">
          <div className={cn(mobile && 'hidden')}>
            <h1 className="text-xl font-semibold">搜索</h1>
            <p className="mt-1 text-sm text-muted-foreground">全文搜索会话中的用户消息和助手回复</p>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索全部会话内容"
              className="h-10 pl-9"
            />
          </div>

          <div className={cn('text-sm text-muted-foreground', error && 'text-destructive')}>{statusText}</div>

          <div className="grid gap-3">
            {groups.map((group) => (
              <section key={group.threadId} className="rounded-md border bg-card">
                <a
                  href={threadHref(group.threadId)}
                  onClick={(event) => {
                    if (!shouldHandleAppLink(event)) return;
                    event.preventDefault();
                    onOpenThread(group.threadId);
                  }}
                  className="flex w-full min-w-0 items-center gap-3 border-b px-3 py-2 text-left transition-colors hover:bg-accent/60"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{group.title}</span>
                  <Badge variant="secondary">{group.results.length} 条</Badge>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{shortTime(group.latestAt)}</span>
                </a>

                <div className="grid gap-1 p-2">
                  {group.results.map((result) => {
                    const snippetBlocks = resultSnippetBlocks(result.content, trimmedQuery);
                    return (
                      <a
                        key={`${result.message_id}:${result.run_id}`}
                        href={threadHref(result.thread_id)}
                        onClick={(event) => {
                          if (!shouldHandleAppLink(event)) return;
                          event.preventDefault();
                          onOpenThread(result.thread_id);
                        }}
                        className="grid gap-1.5 rounded-md p-2 text-left transition-colors hover:bg-accent/60"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge variant="outline">{ROLE_LABELS[result.role]}</Badge>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{shortTime(result.created_at)}</span>
                        </div>
                        <div className="grid gap-2 text-sm leading-5 text-muted-foreground">
                          {snippetBlocks.map((block) => (
                            <div
                              key={`${block.startLine}:${block.endLine}`}
                              className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border bg-background px-2 py-1.5"
                            >
                              {block.hasPrefix && <span className="block text-muted-foreground/70">...</span>}
                              {highlightParts(block.text, trimmedQuery).map((part, index) => (
                                <span
                                  key={`${index}:${part.text}`}
                                  className={part.hit ? 'rounded bg-primary px-0.5 text-primary-foreground' : undefined}
                                >
                                  {part.text}
                                </span>
                              ))}
                              {block.hasSuffix && <span className="block text-muted-foreground/70">...</span>}
                            </div>
                          ))}
                        </div>
                      </a>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
