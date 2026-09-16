import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Database, Image, Layers3, LogOut, Shield, ShieldCheck, Users, Wifi, Wrench } from 'lucide-react';
import { listSystemTenants, sysAdminLogout } from '../sysAdminApi';
import type { TenantSummary } from '@runforge/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NavGroup, SectionButton } from '@/components/ui/settings-nav';
import { SysAdminTenantsPanel } from './panels/SysAdminTenantsPanel';
import { SysAdminAccountsPanel } from './panels/SysAdminAccountsPanel';
import { DatasourceSettingsPanel, type DatasourceSettingsPage } from '../components/datasources/DatasourceSettingsPanel';
import { ToolsSettingsPanel } from '../components/SettingsView';
import { LlmProviderSettingsPanel, McpServerSettingsPanel } from './settings/ProviderSettingsPanels';
import { RuntimeCapabilitySettingsPanel } from './settings/RuntimeCapabilitySettingsPanel';
import { createSystemDatasourceControlApi, createSystemSettingsControlApi } from '../controlApi';
import { SpaceManagementPanel } from '@/components/spaces/SpaceManagementPanel';
import { createSystemSpaceControlApi } from '@/spaceControlApi';

type SysAdminPanel =
  | 'tenants'
  | 'admins'
  | 'spaces'
  | 'llm-models'
  | 'runtime-capabilities'
  | 'mcp-client'
  | 'tools-sandbox'
  | DatasourceSettingsPage;

function isTenantScopedPanel(panel: SysAdminPanel): boolean {
  return panel !== 'tenants' && panel !== 'admins';
}

export function SysAdminApp() {
  const [panel, setPanel] = useState<SysAdminPanel>('tenants');
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [tenantError, setTenantError] = useState('');

  useEffect(() => {
    listSystemTenants()
      .then(({ tenants: rows }) => {
        setTenants(rows);
        setTenantId((current) => current || rows.find((tenant) => tenant.status === 'active')?.id || rows[0]?.id || '');
      })
      .catch((err) => setTenantError((err as Error).message));
  }, []);

  const settingsControlApi = useMemo(() => tenantId ? createSystemSettingsControlApi(tenantId) : null, [tenantId]);
  const datasourceControlApi = useMemo(() => tenantId ? createSystemDatasourceControlApi(tenantId) : null, [tenantId]);
  const spaceControlApi = useMemo(() => tenantId ? createSystemSpaceControlApi(tenantId) : null, [tenantId]);
  const tenantScoped = isTenantScopedPanel(panel);
  const syncTenants = useCallback((rows: TenantSummary[]) => {
    setTenants(rows);
    setTenantId((current) => rows.some((tenant) => tenant.id === current)
      ? current
      : rows.find((tenant) => tenant.status === 'active')?.id || rows[0]?.id || '');
  }, []);

  return (
    <main className="app-main-surface flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">系统设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">定义系统能力，并按租户管理供应商与运行策略</p>
        </div>
        <div className="flex items-center gap-2">
          {tenantScoped && (
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger className="w-64"><SelectValue placeholder="选择目标租户" /></SelectTrigger>
              <SelectContent>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
            <NavGroup label="组织">
              <SectionButton active={panel === 'tenants'} icon={<Users className="h-4 w-4" />} onClick={() => setPanel('tenants')}>
                租户管理
              </SectionButton>
              <SectionButton active={panel === 'admins'} icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setPanel('admins')}>
                系统管理员
              </SectionButton>
              <SectionButton active={panel === 'spaces'} icon={<Layers3 className="h-4 w-4" />} onClick={() => setPanel('spaces')}>
                空间管理
              </SectionButton>
            </NavGroup>
            <NavGroup label="供应商">
              <SectionButton active={panel === 'llm-models'} icon={<Bot className="h-4 w-4" />} onClick={() => setPanel('llm-models')}>
                LLM 供应商
              </SectionButton>
              <SectionButton active={panel === 'runtime-capabilities'} icon={<Image className="h-4 w-4" />} onClick={() => setPanel('runtime-capabilities')}>
                运行时能力
              </SectionButton>
            </NavGroup>
            <NavGroup label="数据源">
              <SectionButton active={panel === 'datasource-connection'} icon={<Database className="h-4 w-4" />} onClick={() => setPanel('datasource-connection')}>
                连接
              </SectionButton>
              <SectionButton active={panel === 'datasource-permissions'} icon={<Shield className="h-4 w-4" />} onClick={() => setPanel('datasource-permissions')}>
                权限
              </SectionButton>
              <SectionButton active={panel === 'datasource-pool'} icon={<Database className="h-4 w-4" />} onClick={() => setPanel('datasource-pool')}>
                账号池
              </SectionButton>
              <SectionButton active={panel === 'datasource-leases'} icon={<Database className="h-4 w-4" />} onClick={() => setPanel('datasource-leases')}>
                租约
              </SectionButton>
            </NavGroup>
            <NavGroup label="运行时">
              <SectionButton active={panel === 'tools-sandbox'} icon={<Wrench className="h-4 w-4" />} onClick={() => setPanel('tools-sandbox')}>
                Shell / 沙箱
              </SectionButton>
              <SectionButton active={panel === 'mcp-client'} icon={<Wifi className="h-4 w-4" />} onClick={() => setPanel('mcp-client')}>
                MCP 客户端
              </SectionButton>
            </NavGroup>
          </CardContent>
        </Card>

        <div className="h-full min-h-0 overflow-hidden">
          {tenantError && <div className="text-sm text-destructive">读取租户失败：{tenantError}</div>}
          {panel === 'tenants' && <SysAdminTenantsPanel onTenantsChanged={syncTenants} />}
          {panel === 'admins' && <SysAdminAccountsPanel />}
          {tenantScoped && !tenantId && !tenantError && (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">请先创建并选择一个租户</div>
          )}
          {tenantId && settingsControlApi && panel === 'llm-models' && <LlmProviderSettingsPanel key={`${tenantId}:${panel}`} controlApi={settingsControlApi} />}
          {tenantId && spaceControlApi && panel === 'spaces' && <SpaceManagementPanel key={`${tenantId}:${panel}`} api={spaceControlApi} />}
          {tenantId && settingsControlApi && panel === 'runtime-capabilities' && <RuntimeCapabilitySettingsPanel key={`${tenantId}:${panel}`} controlApi={settingsControlApi} />}
          {tenantId && settingsControlApi && panel === 'mcp-client' && <McpServerSettingsPanel key={`${tenantId}:${panel}`} controlApi={settingsControlApi} />}
          {tenantId && settingsControlApi && panel === 'tools-sandbox' && <ToolsSettingsPanel key={`${tenantId}:${panel}`} controlApi={settingsControlApi} />}
          {tenantId && datasourceControlApi && panel.startsWith('datasource-') && (
            <DatasourceSettingsPanel key={`${tenantId}:${panel}`} controlApi={datasourceControlApi} page={panel as DatasourceSettingsPage} />
          )}
        </div>
      </div>
    </main>
  );
}
