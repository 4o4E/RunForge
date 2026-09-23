import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeft, Bot, Database, Image, KeyRound, Layers3, LogOut, Package, Shield, ShieldCheck, Users, Wifi, Wrench } from 'lucide-react';
import type { TenantSummary } from '@runforge/contracts';
import { listSystemTenants, sysAdminLogout } from '../sysAdminApi';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NavGroup, SectionButton } from '@/components/ui/settings-nav';
import { SysAdminTenantsPanel } from './panels/SysAdminTenantsPanel';
import { SysAdminAccountsPanel } from './panels/SysAdminAccountsPanel';
import { TenantResourceAuthorizationPanel } from './panels/TenantResourceAuthorizationPanel';
import { DatasourceSettingsPanel, type DatasourceSettingsPage } from '../components/datasources/DatasourceSettingsPanel';
import { ToolsSettingsPanel } from '../components/SettingsView';
import { LlmProviderSettingsPanel, McpServerSettingsPanel } from './settings/ProviderSettingsPanels';
import { RuntimeCapabilitySettingsPanel } from './settings/RuntimeCapabilitySettingsPanel';
import { createSystemDatasourceControlApi, createSystemSettingsControlApi } from '../controlApi';
import { SpaceManagementPanel } from '@/components/spaces/SpaceManagementPanel';
import { SpacePromptManagementPage } from '@/components/spaces/SpacePromptManagementPage';
import { createSystemSpaceControlApi } from '@/spaceControlApi';
import { BusinessPluginManagementPanel } from '@/components/businessPlugins/BusinessPluginManagementPanel';
import { createSystemBusinessPluginControlApi } from '@/businessPluginControlApi';
import { TenantUsersPanel } from '@/components/tenants/TenantUsersPanel';
import { createSystemTenantUsersControlApi } from '@/tenantUsersControlApi';
import { UsageAnalyticsPanel } from '@/components/usage/UsageAnalyticsPanel';
import { getSystemUsage, refreshSystemStorageUsage } from '@/usageApi';

type TenantSection = 'users' | 'spaces' | 'business-plugins';
type SystemSection =
  | 'llm-models'
  | 'runtime-capabilities'
  | 'mcp-client'
  | 'tools-sandbox'
  | 'usage'
  | DatasourceSettingsPage;

type SysAdminRoute =
  | { page: 'tenants' }
  | { page: 'admins' }
  | { page: 'access'; tenantId: string | null }
  | { page: 'tenant'; tenantId: string; section: TenantSection }
  | { page: 'prompt'; tenantId: string; spaceId: string }
  | { page: 'settings'; section: SystemSection };

const TENANT_SECTIONS = new Set<TenantSection>(['users', 'spaces', 'business-plugins']);
const SYSTEM_SECTIONS = new Set<SystemSection>([
  'llm-models',
  'runtime-capabilities',
  'mcp-client',
  'tools-sandbox',
  'usage',
  'datasource-connection',
  'datasource-permissions',
  'datasource-pool',
  'datasource-leases',
]);

const SYSTEM_SECTION_TITLES: Record<SystemSection, string> = {
  'llm-models': 'LLM 供应商',
  'runtime-capabilities': '运行时能力',
  'mcp-client': 'MCP 客户端',
  'tools-sandbox': 'Shell / 沙箱',
  usage: '用量与存储',
  'datasource-connection': '数据源连接',
  'datasource-permissions': '数据源权限',
  'datasource-pool': '数据源账号池',
  'datasource-leases': '数据源租约',
};

function isTenantSection(value: string | undefined): value is TenantSection {
  return value !== undefined && TENANT_SECTIONS.has(value as TenantSection);
}

function isSystemSection(value: string | undefined): value is SystemSection {
  return value !== undefined && SYSTEM_SECTIONS.has(value as SystemSection);
}

function parseSysAdminRoute(pathname: string, search: string): SysAdminRoute {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'sys-admin') return { page: 'tenants' };
  if (segments[1] === 'admins') return { page: 'admins' };
  if (segments[1] === 'tenant-access') {
    return { page: 'access', tenantId: new URLSearchParams(search).get('tenant') };
  }
  if (segments[1] === 'tenants' && segments[2] && segments[3] === 'spaces' && segments[4] && segments[5] === 'prompt') {
    return { page: 'prompt', tenantId: segments[2], spaceId: segments[4] };
  }
  if (segments[1] === 'tenants' && segments[2]) {
    return {
      page: 'tenant',
      tenantId: segments[2],
      section: isTenantSection(segments[3]) ? segments[3] : 'users',
    };
  }
  if (segments[1] === 'settings' && isSystemSection(segments[2])) {
    return { page: 'settings', section: segments[2] };
  }
  return { page: 'tenants' };
}

function sysAdminRoutePath(route: SysAdminRoute): string {
  if (route.page === 'admins') return '/sys-admin/admins';
  if (route.page === 'access') {
    return `/sys-admin/tenant-access${route.tenantId ? `?tenant=${encodeURIComponent(route.tenantId)}` : ''}`;
  }
  if (route.page === 'tenant') {
    return `/sys-admin/tenants/${encodeURIComponent(route.tenantId)}/${route.section}`;
  }
  if (route.page === 'prompt') {
    return `/sys-admin/tenants/${encodeURIComponent(route.tenantId)}/spaces/${encodeURIComponent(route.spaceId)}/prompt`;
  }
  if (route.page === 'settings') return `/sys-admin/settings/${route.section}`;
  return '/sys-admin/tenants';
}

export function SysAdminApp() {
  const [route, setRoute] = useState<SysAdminRoute>(() => (
    parseSysAdminRoute(window.location.pathname, window.location.search)
  ));
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [tenantError, setTenantError] = useState('');
  const tenantId = route.page === 'tenant' || route.page === 'access' || route.page === 'prompt'
    ? route.tenantId ?? ''
    : '';
  const selectedTenant = tenants.find((tenant) => tenant.id === tenantId);

  const navigate = useCallback((next: SysAdminRoute, replace = false) => {
    const path = sysAdminRoutePath(next);
    if (replace) window.history.replaceState(null, '', path);
    else if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, '', path);
    setRoute(next);
  }, []);

  useEffect(() => {
    const initial = parseSysAdminRoute(window.location.pathname, window.location.search);
    const canonicalPath = sysAdminRoutePath(initial);
    if (`${window.location.pathname}${window.location.search}` !== canonicalPath) {
      window.history.replaceState(null, '', canonicalPath);
    }
    const onPopState = () => setRoute(parseSysAdminRoute(window.location.pathname, window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if ((route.page !== 'tenant' && route.page !== 'access' && route.page !== 'prompt') || tenants.length > 0) return;
    listSystemTenants()
      .then(({ tenants: rows }) => {
        setTenants(rows);
        setTenantError('');
        if (route.page === 'access' && !route.tenantId && rows.length > 0) {
          navigate({ page: 'access', tenantId: rows.find((tenant) => tenant.status === 'active')?.id ?? rows[0].id }, true);
        }
      })
      .catch((error) => setTenantError((error as Error).message));
  }, [navigate, route, tenants.length]);

  const settingsControlApi = useMemo(() => createSystemSettingsControlApi(), []);
  const datasourceControlApi = useMemo(() => createSystemDatasourceControlApi(), []);
  const spaceControlApi = useMemo(
    () => tenantId ? createSystemSpaceControlApi(tenantId) : null,
    [tenantId],
  );
  const businessPluginControlApi = useMemo(
    () => tenantId ? createSystemBusinessPluginControlApi(tenantId) : null,
    [tenantId],
  );
  const tenantUsersControlApi = useMemo(
    () => tenantId ? createSystemTenantUsersControlApi(tenantId) : null,
    [tenantId],
  );

  const syncTenants = useCallback((rows: TenantSummary[]) => {
    setTenants(rows);
    setTenantError('');
  }, []);

  function openTenant(nextTenantId: string, section: TenantSection = 'users') {
    navigate({ page: 'tenant', tenantId: nextTenantId, section });
  }

  function headerTitle(): string {
    if (route.page === 'prompt') return '提示词管理';
    if (route.page === 'tenant') return selectedTenant?.name ?? '租户详情';
    if (route.page === 'access') return '租户授权';
    if (route.page === 'admins') return '系统管理员';
    if (route.page === 'settings') return SYSTEM_SECTION_TITLES[route.section];
    return '租户管理';
  }

  function headerDescription(): string {
    if (route.page === 'prompt') return selectedTenant
      ? `管理租户 ${selectedTenant.id} 的空间提示词`
      : '读取租户详情';
    if (route.page === 'tenant') return selectedTenant
      ? `管理租户 ${selectedTenant.id} 的用户、空间和业务插件`
      : '读取租户详情';
    if (route.page === 'access') return '选择租户并授权可使用的系统资源';
    if (route.page === 'settings') return '全系统统一维护，租户可用范围由租户授权决定';
    return '管理系统身份和租户';
  }

  return (
    <main className="app-main-surface flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">{headerTitle()}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{headerDescription()}</p>
        </div>
        <div className="flex items-center gap-2">
          {(route.page === 'tenant' || route.page === 'access' || route.page === 'prompt') && tenants.length > 0 && (
            <Select
              value={tenantId}
              onValueChange={(value) => {
                if (route.page === 'tenant') openTenant(value, route.section);
                else if (route.page === 'prompt') openTenant(value, 'spaces');
                else navigate({ page: 'access', tenantId: value });
              }}
            >
              <SelectTrigger className="w-64"><SelectValue placeholder="选择租户" /></SelectTrigger>
              <SelectContent>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="sm" asChild>
            <a href="/">
              <ArrowLeft className="h-4 w-4" />
              返回聊天
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void sysAdminLogout().then(() => { window.location.href = '/sys-admin'; })}
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 items-start gap-4 p-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <Card className="h-full min-h-0 overflow-hidden rounded-lg shadow-sm">
          <CardContent className="grid max-h-full gap-2 overflow-y-auto p-3">
            <NavGroup label="系统管理">
              <SectionButton active={route.page === 'tenants'} icon={<Users className="h-4 w-4" />} onClick={() => navigate({ page: 'tenants' })}>
                租户管理
              </SectionButton>
              <SectionButton
                active={route.page === 'access'}
                icon={<KeyRound className="h-4 w-4" />}
                onClick={() => navigate({
                  page: 'access',
                  tenantId: tenantId || tenants.find((tenant) => tenant.status === 'active')?.id || tenants[0]?.id || null,
                })}
              >
                租户授权
              </SectionButton>
              <SectionButton active={route.page === 'admins'} icon={<ShieldCheck className="h-4 w-4" />} onClick={() => navigate({ page: 'admins' })}>
                系统管理员
              </SectionButton>
            </NavGroup>

            <NavGroup label="系统设置">
              <SectionButton active={route.page === 'settings' && route.section === 'llm-models'} icon={<Bot className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'llm-models' })}>LLM 供应商</SectionButton>
              <SectionButton active={route.page === 'settings' && route.section === 'runtime-capabilities'} icon={<Image className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'runtime-capabilities' })}>运行时能力</SectionButton>
              <SectionButton active={route.page === 'settings' && route.section === 'mcp-client'} icon={<Wifi className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'mcp-client' })}>MCP 客户端</SectionButton>
              <SectionButton active={route.page === 'settings' && route.section === 'tools-sandbox'} icon={<Wrench className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'tools-sandbox' })}>Shell / 沙箱</SectionButton>
              <SectionButton active={route.page === 'settings' && route.section === 'usage'} icon={<Activity className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'usage' })}>用量与存储</SectionButton>
            </NavGroup>

            <NavGroup label="系统数据源">
              <SectionButton active={route.page === 'settings' && route.section === 'datasource-connection'} icon={<Database className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'datasource-connection' })}>连接</SectionButton>
              <SectionButton active={route.page === 'settings' && route.section === 'datasource-permissions'} icon={<Shield className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'datasource-permissions' })}>权限</SectionButton>
              <SectionButton active={route.page === 'settings' && route.section === 'datasource-pool'} icon={<Database className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'datasource-pool' })}>账号池</SectionButton>
              <SectionButton active={route.page === 'settings' && route.section === 'datasource-leases'} icon={<Database className="h-4 w-4" />} onClick={() => navigate({ page: 'settings', section: 'datasource-leases' })}>租约</SectionButton>
            </NavGroup>

            {(route.page === 'tenant' || route.page === 'prompt') && selectedTenant && (
              <NavGroup label={selectedTenant.name}>
                <SectionButton active={route.page === 'tenant' && route.section === 'users'} icon={<Users className="h-4 w-4" />} onClick={() => openTenant(tenantId, 'users')}>用户</SectionButton>
                <SectionButton active={route.page === 'prompt' || (route.page === 'tenant' && route.section === 'spaces')} icon={<Layers3 className="h-4 w-4" />} onClick={() => openTenant(tenantId, 'spaces')}>空间</SectionButton>
                <SectionButton active={route.page === 'tenant' && route.section === 'business-plugins'} icon={<Package className="h-4 w-4" />} onClick={() => openTenant(tenantId, 'business-plugins')}>业务插件</SectionButton>
              </NavGroup>
            )}
          </CardContent>
        </Card>

        <div className="h-full min-h-0 overflow-hidden">
          {tenantError && <div className="text-sm text-destructive">读取租户失败：{tenantError}</div>}
          {route.page === 'tenants' && <SysAdminTenantsPanel onTenantsChanged={syncTenants} onSelectTenant={(id) => openTenant(id)} />}
          {route.page === 'admins' && <SysAdminAccountsPanel />}
          {route.page === 'access' && selectedTenant && <TenantResourceAuthorizationPanel tenant={selectedTenant} />}
          {route.page === 'access' && !tenantError && tenants.length === 0 && (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">请先创建租户</div>
          )}
          {route.page === 'settings' && route.section === 'llm-models' && <LlmProviderSettingsPanel controlApi={settingsControlApi} />}
          {route.page === 'settings' && route.section === 'runtime-capabilities' && <RuntimeCapabilitySettingsPanel controlApi={settingsControlApi} />}
          {route.page === 'settings' && route.section === 'mcp-client' && <McpServerSettingsPanel controlApi={settingsControlApi} />}
          {route.page === 'settings' && route.section === 'tools-sandbox' && <ToolsSettingsPanel controlApi={settingsControlApi} />}
          {route.page === 'settings' && route.section === 'usage' && (
            <UsageAnalyticsPanel load={getSystemUsage} showTenantFilter refreshStorage={refreshSystemStorageUsage} />
          )}
          {route.page === 'settings' && route.section.startsWith('datasource-') && (
            <DatasourceSettingsPanel controlApi={datasourceControlApi} page={route.section as DatasourceSettingsPage} />
          )}
          {(route.page === 'tenant' || route.page === 'prompt') && !tenantError && tenants.length > 0 && !selectedTenant && (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-destructive">租户 {tenantId} 不存在</div>
          )}
          {route.page === 'tenant' && selectedTenant && route.section === 'users' && tenantUsersControlApi && (
            <TenantUsersPanel key={`${tenantId}:users`} api={tenantUsersControlApi} actor={{ kind: 'system' }} />
          )}
          {route.page === 'tenant' && selectedTenant && route.section === 'spaces' && spaceControlApi && (
            <SpaceManagementPanel
              key={`${tenantId}:spaces`}
              api={spaceControlApi}
              onManagePrompt={(spaceId) => navigate({ page: 'prompt', tenantId, spaceId })}
            />
          )}
          {route.page === 'tenant' && selectedTenant && route.section === 'business-plugins' && businessPluginControlApi && (
            <BusinessPluginManagementPanel key={`${tenantId}:business-plugins`} api={businessPluginControlApi} />
          )}
          {route.page === 'prompt' && selectedTenant && spaceControlApi && (
            <SpacePromptManagementPage
              key={`${tenantId}:${route.spaceId}`}
              api={spaceControlApi}
              spaceId={route.spaceId}
              onBack={() => openTenant(tenantId, 'spaces')}
            />
          )}
        </div>
      </div>
    </main>
  );
}
