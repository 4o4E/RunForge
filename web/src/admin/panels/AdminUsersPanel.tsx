import { useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { createTenantUser, listTenantUsers, updateTenantUser } from '../../api';
import type { TenantUserRole, TenantUserSummary } from '@runforge/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AdminUsersPanel({ tenantId, currentUserId, currentRole }: { tenantId: string; currentUserId: string; currentRole: TenantUserRole }) {
  const [users, setUsers] = useState<TenantUserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<TenantUserRole>('member');
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const result = await listTenantUsers(tenantId);
      setUsers(result.users);
    } catch (err) {
      setMessage(`读取用户列表失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [tenantId]);

  async function createUser() {
    setCreating(true);
    setMessage('');
    try {
      await createTenantUser(tenantId, { email: newEmail.trim(), password: newPassword, role: newRole });
      setCreateOpen(false);
      setNewEmail('');
      setNewPassword('');
      setNewRole('member');
      await refresh();
    } catch (err) {
      setMessage(`创建用户失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function changeRole(user: TenantUserSummary, role: TenantUserRole) {
    setMessage('');
    try {
      const updated = await updateTenantUser(tenantId, user.id, { role });
      setUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setMessage(`修改角色失败：${(err as Error).message}`);
      await refresh();
    }
  }

  async function changeStatus(user: TenantUserSummary, status: 'active' | 'disabled') {
    setMessage('');
    try {
      const updated = await updateTenantUser(tenantId, user.id, { status });
      setUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setMessage(`修改状态失败：${(err as Error).message}`);
      await refresh();
    }
  }

  // admin 只能管理 member 账号，也不能把任何人设成 admin/owner；不能编辑自己——
  // 服务端已经强制这些规则(server/src/api/tenants.ts)，这里只是提前把控件 disabled
  // 掉，避免用户点了却收到 403。
  function canEditRole(user: TenantUserSummary): boolean {
    if (user.id === currentUserId) return false;
    if (currentRole === 'admin' && user.role !== 'member') return false;
    return true;
  }

  return (
    <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">用户</CardTitle>
            <CardDescription>{users.length} 个账号</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {message && <span className="max-w-md truncate text-sm text-muted-foreground">{message}</span>}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建用户
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>邮箱</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              const editable = canEditRole(user);
              return (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    {user.email}
                    {user.id === currentUserId && <Badge variant="outline" className="ml-2">我</Badge>}
                  </TableCell>
                  <TableCell>
                    <Select value={user.role} disabled={!editable} onValueChange={(value) => void changeRole(user, value as TenantUserRole)}>
                      <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="owner">owner</SelectItem>
                        <SelectItem value="admin">admin</SelectItem>
                        <SelectItem value="member">member</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={user.status === 'active'}
                        disabled={!editable}
                        onCheckedChange={(checked) => void changeStatus(user, checked ? 'active' : 'disabled')}
                      />
                      <span className="text-xs text-muted-foreground">{user.status}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(user.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>只有 owner 能创建 admin / owner 账号；admin 只能创建 member。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input type="email" placeholder="邮箱" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
            <Input type="password" placeholder="密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            <Select value={newRole} onValueChange={(value) => setNewRole(value as TenantUserRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
                <SelectItem value="owner">owner</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={() => void createUser()} disabled={creating || !newEmail.trim() || !newPassword}>
              {creating ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
