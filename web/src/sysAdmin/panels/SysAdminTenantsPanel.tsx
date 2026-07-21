import { useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { createSystemTenant, listSystemTenants, updateSystemTenantStatus } from '../../sysAdminApi';
import type { TenantSummary } from '@runforge/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function SysAdminTenantsPanel() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const result = await listSystemTenants();
      setTenants(result.tenants);
    } catch (err) {
      setMessage(`读取租户列表失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createTenant() {
    setCreating(true);
    setMessage('');
    try {
      await createSystemTenant({ id: id.trim(), name: name.trim(), ownerEmail: ownerEmail.trim(), ownerPassword });
      setCreateOpen(false);
      setId('');
      setName('');
      setOwnerEmail('');
      setOwnerPassword('');
      await refresh();
    } catch (err) {
      setMessage(`创建租户失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(tenant: TenantSummary, active: boolean) {
    setMessage('');
    try {
      const result = await updateSystemTenantStatus(tenant.id, active ? 'active' : 'suspended');
      setTenants((prev) => prev.map((item) => (item.id === result.tenant.id ? result.tenant : item)));
    } catch (err) {
      setMessage(`更新租户状态失败：${(err as Error).message}`);
      await refresh();
    }
  }

  return (
    <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">租户</CardTitle>
            <CardDescription>{tenants.length} 个租户</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {message && <span className="max-w-md truncate text-sm text-muted-foreground">{message}</span>}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建租户
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((tenant) => (
              <TableRow key={tenant.id}>
                <TableCell className="font-medium">{tenant.id}</TableCell>
                <TableCell>{tenant.name}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch checked={tenant.status === 'active'} onCheckedChange={(checked) => void toggleStatus(tenant, checked)} />
                    <Badge variant={tenant.status === 'active' ? 'default' : 'secondary'}>{tenant.status}</Badge>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(tenant.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建租户</DialogTitle>
            <DialogDescription>会同时创建该租户的第一个 owner 账号，否则新租户没人能登录。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input placeholder="租户 ID（字母/数字/下划线/短横线）" value={id} onChange={(event) => setId(event.target.value)} />
            <Input placeholder="租户名称" value={name} onChange={(event) => setName(event.target.value)} />
            <Input type="email" placeholder="owner 邮箱" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} />
            <Input type="password" placeholder="owner 密码" value={ownerPassword} onChange={(event) => setOwnerPassword(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button
              onClick={() => void createTenant()}
              disabled={creating || !id.trim() || !name.trim() || !ownerEmail.trim() || !ownerPassword}
            >
              {creating ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
