import { Bot, Moon, Plus, Sun } from 'lucide-react';
import type { Thread } from '../api';
import type { Theme } from '../useTheme';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface Props {
  threads: Thread[];
  activeId: string | null;
  theme: Theme;
  onToggleTheme: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
}

function threadLabel(t: Thread): string {
  if (t.title) return t.title;
  return `会话 ${t.id.slice(0, 8)}`;
}

export function Sidebar({ threads, activeId, theme, onToggleTheme, onNew, onSelect }: Props) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-card">
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
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            title={threadLabel(t)}
            className={cn(
              'block w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors',
              t.id === activeId
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-foreground hover:bg-accent/60',
            )}
          >
            {threadLabel(t)}
          </button>
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
