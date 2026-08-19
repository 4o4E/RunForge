import { useEffect, useState } from 'react';
import { ArrowLeft, KeyRound, LogOut, Users } from 'lucide-react';
import { getCurrentUser, logout } from '../api';
import type { TenantUserSummary } from '@runforge/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { NavGroup, SectionButton } from '@/components/ui/settings-nav';
import { AdminUsersPanel } from './panels/AdminUsersPanel';
import { AdminTokensPanel } from './panels/AdminTokensPanel';

type AdminPanel = 'users' | 'tokens';

export function AdminApp() {
  const [user, setUser] = useState<TenantUserSummary | null>(null);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<AdminPanel>('users');

  useEffect(() => {
    void getCurrentUser()
      .then(setUser)
      .catch((err) => setError((err as Error).message || '读取当前账号失败'));
  }, []);

  if (error) {
    return (
      <div className="app-main-surface flex h-full min-h-0 items-center justify-center px-4 text-sm text-destructive">{error}</div>
    );
  }
  if (!user) {
    return (
      <div className="app-main-surface flex h-full min-h-0 items-center justify-center px-4">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <main className="app-main-surface flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">租户设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">{user.email} · {user.role} · 只管理租户 {user.tenantId}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/">
            <Button variant="outline" size="sm">
              <ArrowLeft className="h-4 w-4" />
              返回聊天
            </Button>
          </a>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void logout().then(() => {
                window.location.href = '/';
              });
            }}
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 items-start gap-4 p-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <Card className="h-full min-h-0 overflow-hidden rounded-lg shadow-sm">
          <CardContent className="grid max-h-full gap-2 overflow-y-auto p-3">
            <NavGroup label="成员与访问">
              <SectionButton active={panel === 'users'} icon={<Users className="h-4 w-4" />} onClick={() => setPanel('users')}>
                用户管理
              </SectionButton>
              {user.role === 'owner' && (
                <SectionButton active={panel === 'tokens'} icon={<KeyRound className="h-4 w-4" />} onClick={() => setPanel('tokens')}>
                  API Token
                </SectionButton>
              )}
            </NavGroup>
          </CardContent>
        </Card>

        <div className="h-full min-h-0 overflow-hidden">
          {panel === 'users' && <AdminUsersPanel tenantId={user.tenantId} currentUserId={user.id} currentRole={user.role} />}
          {panel === 'tokens' && user.role === 'owner' && <AdminTokensPanel tenantId={user.tenantId} />}
        </div>
      </div>
    </main>
  );
}
