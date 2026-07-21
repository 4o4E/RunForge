import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 设置/管理类页面共用的"左侧导航"纯展示组件：SettingsView.tsx、/admin 的 AdminApp.tsx、
// /sys-admin 的 SysAdminApp.tsx 都是同一套"NavGroup 分组 + SectionButton 高亮项"布局。

export function SectionButton({
  active,
  children,
  icon,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

export function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
