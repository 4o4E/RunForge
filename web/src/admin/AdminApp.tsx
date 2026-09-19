import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Layers3, LogOut, Package, Users } from 'lucide-react';
import { getCurrentUser, logout } from '../api';
import type { TenantUserSummary } from '@runforge/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { NavGroup, SectionButton } from '@/components/ui/settings-nav';
import { TenantUsersPanel } from '@/components/tenants/TenantUsersPanel';
import { SpaceManagementPanel } from '@/components/spaces/SpaceManagementPanel';
import { SpacePromptManagementPage } from '@/components/spaces/SpacePromptManagementPage';
import { createTenantSpaceControlApi } from '@/spaceControlApi';
import { BusinessPluginManagementPanel } from '@/components/businessPlugins/BusinessPluginManagementPanel';
import { createTenantBusinessPluginControlApi } from '@/businessPluginControlApi';
import { createTenantUsersControlApi } from '@/tenantUsersControlApi';

type AdminSection = 'users' | 'spaces' | 'business-plugins';
type AdminRoute =
  | { page: 'section'; section: AdminSection }
  | { page: 'prompt'; spaceId: string };

const ADMIN_SECTIONS = new Set<AdminSection>(['users', 'spaces', 'business-plugins']);

function isAdminSection(value: string | undefined): value is AdminSection {
  return value !== undefined && ADMIN_SECTIONS.has(value as AdminSection);
}

function parseAdminRoute(pathname: string): AdminRoute {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'admin') return { page: 'section', section: 'users' };
  if (segments[1] === 'spaces' && segments[2] && segments[3] === 'prompt') {
    return { page: 'prompt', spaceId: segments[2] };
  }
  return { page: 'section', section: isAdminSection(segments[1]) ? segments[1] : 'users' };
}

function adminRoutePath(route: AdminRoute): string {
  if (route.page === 'prompt') return `/admin/spaces/${encodeURIComponent(route.spaceId)}/prompt`;
  return `/admin/${route.section}`;
}

export function AdminApp() {
  const [user, setUser] = useState<TenantUserSummary | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<AdminRoute>(() => parseAdminRoute(window.location.pathname));
  const spaceControlApi = useMemo(
    () => user ? createTenantSpaceControlApi(user.tenantId) : null,
    [user?.tenantId],
  );
  const businessPluginControlApi = useMemo(
    () => user ? createTenantBusinessPluginControlApi(user.tenantId) : null,
    [user?.tenantId],
  );
  const tenantUsersControlApi = useMemo(
    () => user ? createTenantUsersControlApi(user.tenantId) : null,
    [user?.tenantId],
  );

  const navigate = useCallback((next: AdminRoute, replace = false) => {
    const path = adminRoutePath(next);
    if (replace) window.history.replaceState(null, '', path);
    else if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setRoute(next);
  }, []);

  useEffect(() => {
    const initial = parseAdminRoute(window.location.pathname);
    const canonicalPath = adminRoutePath(initial);
    if (window.location.pathname !== canonicalPath) window.history.replaceState(null, '', canonicalPath);
    const onPopState = () => setRoute(parseAdminRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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
          <h1 className="text-xl font-semibold">{route.page === 'prompt' ? '提示词管理' : '租户设置'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{user.email} · {user.role} · 只管理租户 {user.tenantId}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href="/">
              <ArrowLeft className="h-4 w-4" />
              返回聊天
            </a>
          </Button>
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
            <NavGroup label="租户管理">
              <SectionButton active={route.page === 'section' && route.section === 'users'} icon={<Users className="h-4 w-4" />} onClick={() => navigate({ page: 'section', section: 'users' })}>
                用户管理
              </SectionButton>
              <SectionButton active={route.page === 'prompt' || (route.page === 'section' && route.section === 'spaces')} icon={<Layers3 className="h-4 w-4" />} onClick={() => navigate({ page: 'section', section: 'spaces' })}>
                空间管理
              </SectionButton>
              <SectionButton active={route.page === 'section' && route.section === 'business-plugins'} icon={<Package className="h-4 w-4" />} onClick={() => navigate({ page: 'section', section: 'business-plugins' })}>
                业务插件
              </SectionButton>
            </NavGroup>
          </CardContent>
        </Card>

        <div className="h-full min-h-0 overflow-hidden">
          {route.page === 'section' && route.section === 'users' && tenantUsersControlApi && (
            <TenantUsersPanel
              api={tenantUsersControlApi}
              actor={{ kind: 'tenant', userId: user.id, role: user.role }}
            />
          )}
          {route.page === 'section' && route.section === 'spaces' && spaceControlApi && (
            <SpaceManagementPanel
              api={spaceControlApi}
              onManagePrompt={(spaceId) => navigate({ page: 'prompt', spaceId })}
            />
          )}
          {route.page === 'section' && route.section === 'business-plugins' && businessPluginControlApi && (
            <BusinessPluginManagementPanel api={businessPluginControlApi} />
          )}
          {route.page === 'prompt' && spaceControlApi && (
            <SpacePromptManagementPage
              key={route.spaceId}
              api={spaceControlApi}
              spaceId={route.spaceId}
              onBack={() => navigate({ page: 'section', section: 'spaces' })}
            />
          )}
        </div>
      </div>
    </main>
  );
}
