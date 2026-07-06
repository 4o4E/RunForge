import type { MouseEvent } from 'react';
import { Archive, Bot, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Pin, PinOff, Search, Settings, SquarePen, Trash2 } from 'lucide-react';
import type { Thread } from '../api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface Props {
  threads: Thread[];
  activeId: string | null;
  activeView: 'chat' | 'search';
  settingsOpen: boolean;
  width: number | string;
  collapsed: boolean;
  newHref: string;
  searchHref: string;
  threadHref: (id: string) => string;
  onToggleCollapsed: () => void;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onTogglePin: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

function threadLabel(t: Thread): string {
  if (t.title?.trim()) return t.title;
  if (t.fallback_title?.trim()) return t.fallback_title;
  return `会话 ${t.id.slice(0, 8)}`;
}

function shouldHandleAppLink(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

export function Sidebar({
  threads,
  activeId,
  activeView,
  settingsOpen,
  width,
  collapsed,
  newHref,
  searchHref,
  threadHref,
  onToggleCollapsed,
  onNew,
  onSearch,
  onSettings,
  onSelect,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
}: Props) {
  if (collapsed) {
    return (
      <aside className="app-sidebar-surface flex h-full w-full shrink-0 flex-col items-center border-r py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="group relative flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="展开会话列表"
        >
          <Bot className="size-4 transition-opacity group-hover:opacity-0" />
          <PanelLeftOpen className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100" />
          <span className="sr-only">展开会话列表</span>
        </button>
        <a
          href={newHref}
          onClick={(event) => {
            if (!shouldHandleAppLink(event)) return;
            event.preventDefault();
            onNew();
          }}
          className="mt-3 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="新建会话"
        >
          <SquarePen className="size-4" />
          <span className="sr-only">新建会话</span>
        </a>
        <a
          href={searchHref}
          onClick={(event) => {
            if (!shouldHandleAppLink(event)) return;
            event.preventDefault();
            onSearch();
          }}
          className={cn(
            'mt-2 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
            activeView === 'search' && 'bg-accent text-accent-foreground ring-1 ring-border',
          )}
          title="搜索会话"
        >
          <Search className="size-4" />
          <span className="sr-only">搜索会话</span>
        </a>
        <div className="min-h-0 flex-1" />
        <button
          type="button"
          onClick={onSettings}
          className={cn(
            'flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
            settingsOpen && 'bg-accent text-accent-foreground ring-1 ring-border',
          )}
          title="配置"
        >
          <Settings className="size-4" />
          <span className="sr-only">配置</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="app-sidebar-surface flex h-full shrink-0 flex-col border-r" style={{ width }}>
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="h-4 w-4" />
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">RunForge</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8 shrink-0 text-muted-foreground"
          onClick={onToggleCollapsed}
          title="收起会话列表"
        >
          <PanelLeftClose className="size-4" />
          <span className="sr-only">收起会话列表</span>
        </Button>
      </div>

      <div className="grid gap-1 px-2">
        <Button asChild variant="ghost" size="sm" className="h-9 w-full justify-start pl-2 pr-3 text-sm text-muted-foreground">
          <a
            href={newHref}
            onClick={(event) => {
              if (!shouldHandleAppLink(event)) return;
              event.preventDefault();
              onNew();
            }}
          >
            <SquarePen className="h-4 w-4" /> 新建会话
          </a>
        </Button>
        <Button asChild variant={activeView === 'search' ? 'secondary' : 'ghost'} size="sm" className="h-9 w-full justify-start pl-2 pr-3 text-sm text-muted-foreground data-[active=true]:text-foreground">
          <a
            href={searchHref}
            data-active={activeView === 'search'}
            onClick={(event) => {
              if (!shouldHandleAppLink(event)) return;
              event.preventDefault();
              onSearch();
            }}
          >
            <Search className="h-4 w-4" /> 搜索会话
          </a>
        </Button>
      </div>

      <div className="mt-4 px-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">会话</div>
      <nav className="scrollbar-thin mt-1 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {threads.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">还没有会话</div>}
        {threads.map((t) => (
          <div
            key={t.id}
            className={cn(
              'group/thread relative flex items-center rounded-md transition-colors',
              activeView === 'chat' && t.id === activeId
                ? 'bg-accent text-accent-foreground shadow-sm ring-1 ring-border'
                : 'text-foreground hover:bg-accent/60',
            )}
          >
            <a
              href={threadHref(t.id)}
              onClick={(event) => {
                if (!shouldHandleAppLink(event)) return;
                event.preventDefault();
                onSelect(t.id);
              }}
              title={threadLabel(t)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-2 pl-2 pr-3 text-left text-sm transition-[padding] group-hover/thread:pr-9"
            >
              {t.pinned_at && <Pin className="size-3 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 truncate">{threadLabel(t)}</span>
            </a>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="会话操作"
                  onClick={(event) => event.stopPropagation()}
                  className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:opacity-100 group-hover/thread:opacity-100"
                >
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">会话操作</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={() => onTogglePin(t.id)}>
                  {t.pinned_at ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                  {t.pinned_at ? '取消置顶' : '置顶'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRename(t.id)}>
                  <Pencil className="size-4" />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onArchive(t.id)}>
                  <Archive className="size-4" />
                  归档
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(t.id)}>
                  <Trash2 className="size-4" />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </nav>

      <div className="mt-auto">
        <Separator />
        <div className="px-2 py-2">
          <Button
            variant={settingsOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onSettings}
            className="h-9 w-full justify-start pl-2 pr-3 text-sm text-muted-foreground data-[active=true]:text-foreground"
            data-active={settingsOpen}
          >
            <Settings className="h-4 w-4" /> 设置
          </Button>
        </div>
      </div>
    </aside>
  );
}
