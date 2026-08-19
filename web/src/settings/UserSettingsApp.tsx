import { ArrowLeft, LogOut } from 'lucide-react';
import { logout } from '../api';
import { SettingsView } from '../components/SettingsView';
import { Button } from '@/components/ui/button';

export function UserSettingsApp() {
  return (
    <main className="app-main-surface flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">用户设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">只影响当前用户的界面、用量视图和会话</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/"><ArrowLeft className="h-4 w-4" />返回聊天</a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void logout().then(() => { window.location.href = '/'; })}
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </Button>
        </div>
      </div>
      <SettingsView />
    </main>
  );
}
