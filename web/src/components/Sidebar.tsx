import type { Thread } from '../api';
import type { Theme } from '../useTheme';

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
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-surface-500 bg-surface-100">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-500 text-white">🤖</div>
        <span className="text-sm font-semibold text-surface-950">my-agent</span>
      </div>

      <div className="px-3">
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-primary-600"
        >
          <span className="text-base leading-none">+</span> 新建会话
        </button>
      </div>

      <div className="mt-4 px-3 text-[11px] font-semibold uppercase tracking-wide text-surface-700">会话</div>
      <nav className="scrollbar-thin mt-1 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {threads.length === 0 && <div className="px-2 py-3 text-xs text-surface-700">还没有会话</div>}
        {threads.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition ${
              t.id === activeId
                ? 'bg-primary-50 font-medium text-primary-800 ring-1 ring-primary-200 dark:bg-primary-500/15 dark:text-primary-200 dark:ring-primary-500/30'
                : 'text-surface-900 hover:bg-surface-300'
            }`}
            title={threadLabel(t)}
          >
            {threadLabel(t)}
          </button>
        ))}
      </nav>

      <div className="border-t border-surface-500 p-3">
        <button
          onClick={onToggleTheme}
          className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-surface-900 transition hover:bg-surface-300"
        >
          {theme === 'dark' ? '☀️ 浅色模式' : '🌙 深色模式'}
        </button>
      </div>
    </aside>
  );
}
