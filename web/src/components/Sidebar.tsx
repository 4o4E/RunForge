import { Bot, Moon, Plus, Sun, Trash2 } from 'lucide-react';
import type { Thread } from '../api';
import type { Theme } from '../useTheme';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface Props {
  threads: Thread[];
  activeId: string | null;
  width: number;
  theme: Theme;
  onToggleTheme: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function threadLabel(t: Thread): string {
  if (t.title) return t.title;
  return `会话 ${t.id.slice(0, 8)}`;
}

export function Sidebar({ threads, activeId, width, theme, onToggleTheme, onNew, onSelect, onDelete }: Props) {
  return (
    <aside className="flex h-full shrink-0 flex-col bg-card" style={{ width }}>
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold">my-agent</span>
      </div>

      <div className="px-3">
        <Button onClick={onNew} className="w-full">
          <Plus className="h-4 w-4" /> 新建会话
        </Button>
      </div>

      <div className="mt-4 px-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">会话</div>
      <nav className="scrollbar-thin mt-1 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {threads.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">还没有会话</div>}
        {threads.map((t) => (
          <div
            key={t.id}
            className={cn(
              'group/thread flex items-center rounded-md transition-colors',
              t.id === activeId ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground hover:bg-accent/60',
            )}
          >
            <button
              onClick={() => onSelect(t.id)}
              title={threadLabel(t)}
              className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
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
              className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/thread:opacity-100"
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
