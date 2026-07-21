import { useState } from 'react';
import { LogOut, ShieldCheck, Users } from 'lucide-react';
import { sysAdminLogout } from '../sysAdminApi';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NavGroup, SectionButton } from '@/components/ui/settings-nav';
import { SysAdminTenantsPanel } from './panels/SysAdminTenantsPanel';
import { SysAdminAccountsPanel } from './panels/SysAdminAccountsPanel';

type SysAdminPanel = 'tenants' | 'admins';

export function SysAdminApp() {
  const [panel, setPanel] = useState<SysAdminPanel>('tenants');

  return (
    <main className="app-main-surface flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">系统管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理系统底层和所有租户</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void sysAdminLogout().then(() => {
              window.location.href = '/sys-admin';
            });
          }}
        >
          <LogOut className="h-4 w-4" />
          退出登录
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 items-start gap-4 p-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <Card className="h-full min-h-0 overflow-hidden rounded-lg shadow-sm">
          <CardContent className="grid max-h-full gap-2 overflow-y-auto p-3">
            <NavGroup label="多租户">
              <SectionButton active={panel === 'tenants'} icon={<Users className="h-4 w-4" />} onClick={() => setPanel('tenants')}>
                租户管理
              </SectionButton>
            </NavGroup>
            <NavGroup label="系统">
              <SectionButton active={panel === 'admins'} icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setPanel('admins')}>
                系统管理员
              </SectionButton>
            </NavGroup>
          </CardContent>
        </Card>

        <div className="h-full min-h-0 overflow-hidden">
          {panel === 'tenants' && <SysAdminTenantsPanel />}
          {panel === 'admins' && <SysAdminAccountsPanel />}
        </div>
      </div>
    </main>
  );
}
