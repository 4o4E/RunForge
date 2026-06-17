import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type NotificationVariant = 'success' | 'error' | 'info';

interface NotificationInput {
  title: string;
  description?: string;
  variant?: NotificationVariant;
  durationMs?: number;
}

interface NotificationItem extends Required<Pick<NotificationInput, 'title' | 'variant'>> {
  id: string;
  description?: string;
}

interface NotificationContextValue {
  notify: (input: NotificationInput) => string;
  dismiss: (id: string) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

function notificationIcon(variant: NotificationVariant) {
  if (variant === 'success') return <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-300" />;
  if (variant === 'error') return <XCircle className="mt-0.5 h-4 w-4 text-destructive" />;
  return <Info className="mt-0.5 h-4 w-4 text-muted-foreground" />;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const id = `notice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const item: NotificationItem = {
      id,
      title: input.title,
      description: input.description,
      variant: input.variant ?? 'info',
    };
    setItems((current) => [item, ...current].slice(0, 5));
    const durationMs = input.durationMs ?? (item.variant === 'error' ? 8000 : 5000);
    if (durationMs > 0) window.setTimeout(() => dismiss(id), durationMs);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({ notify, dismiss }), [dismiss, notify]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] grid w-[min(380px,calc(100vw-2rem))] gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            role={item.variant === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg',
              item.variant === 'success' && 'border-emerald-500/40',
              item.variant === 'error' && 'border-destructive/50',
            )}
          >
            {notificationIcon(item.variant)}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{item.title}</div>
              {item.description && <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">{item.description}</div>}
            </div>
            <Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1" onClick={() => dismiss(item.id)} aria-label="关闭通知">
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useNotifications 必须在 NotificationProvider 内使用');
  return context;
}
