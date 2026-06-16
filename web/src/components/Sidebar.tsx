import { Bot, Moon, PanelLeftClose, PanelLeftOpen, Plus, Settings, Sun, Trash2 } from 'lucide-react';
import type { Thread } from '../api';
import type { Theme } from '../useTheme';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface Props {
  threads: Thread[];
  activeId: string | null;
  activeView: 'chat' | 'settings';
  width: number | string;
  collapsed: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  onToggleCollapsed: () => void;
  onNew: () => void;
  onSettings: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function threadLabel(t: Thread): string {
  if (t.title) return t.title;
  return `会话 ${t.id.slice(0, 8)}`;
}

export function Sidebar({
  threads,
  activeId,
  activeView,
  width,
  collapsed,
  theme,
  onToggleTheme,
  onToggleCollapsed,
  onNew,
  onSettings,
  onSelect,
  onDelete,
}: Props) {
  if (collapsed) {
    return (
      <aside className="flex h-full w-full shrink-0 flex-col items-center border-r bg-card py-3">
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
        <button
          type="button"
          onClick={onNew}
          className="mt-3 flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          title="新建会话"
        >
          <Plus className="size-4" />
          <span className="sr-only">新建会话</span>
        </button>
        <button
          type="button"
          onClick={onSettings}
          className={cn(
            'mt-2 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
            activeView === 'settings' && 'bg-accent text-accent-foreground',
          )}
          title="配置"
        >
          <Settings className="size-4" />
          <span className="sr-only">配置</span>
        </button>
        <div className="min-h-0 flex-1" />
        <Separator className="my-3 w-8" />
        <button
          type="button"
          onClick={onToggleTheme}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={theme === 'dark' ? '浅色模式' : '深色模式'}
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          <span className="sr-only">{theme === 'dark' ? '浅色模式' : '深色模式'}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full shrink-0 flex-col bg-card" style={{ width }}>
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="h-4 w-4" />
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">my-agent</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          onClick={onToggleCollapsed}
          title="收起会话列表"
        >
          <PanelLeftClose className="size-4" />
          <span className="sr-only">收起会话列表</span>
        </Button>
      </div>

      <div className="px-3">
        <Button onClick={onNew} className="w-full">
          <Plus className="h-4 w-4" /> 新建会话
        </Button>
      </div>

      <div className="mt-2 px-3">
        <Button
          variant={activeView === 'settings' ? 'secondary' : 'ghost'}
          onClick={onSettings}
          className="w-full justify-start text-muted-foreground"
        >
          <Settings className="h-4 w-4" /> 配置
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
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-foreground hover:bg-accent/60',
            )}
          >
            <button
              onClick={() => onSelect(t.id)}
              title={threadLabel(t)}
              className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm transition-[padding] group-hover/thread:pr-9"
            >
              {threadLabel(t)}
            </button>
            <button
              type="button"
              title="删除会话"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(t.id);
              }}
              className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-accent text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/thread:opacity-100"
            >
              <Trash2 className="size-3.5" />
              <span className="sr-only">删除会话</span>
            </button>
          </div>
        ))}
      </nav>

      <Separator />
      <div className="p-3">
        <Button variant="ghost" onClick={onToggleTheme} className="w-full justify-start text-muted-foreground">
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {theme === 'dark' ? '浅色模式' : '深色模式'}
        </Button>
      </div>
    </aside>
  );
}
