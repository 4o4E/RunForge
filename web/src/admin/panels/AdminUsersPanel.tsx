import { useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw } from 'lucide-react';
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
  const [editingUser, setEditingUser] = useState<TenantUserSummary | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState<TenantUserRole>('member');
  const [editStatus, setEditStatus] = useState<'active' | 'disabled'>('active');
  const [editing, setEditing] = useState(false);

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

  function canEditUser(user: TenantUserSummary): boolean {
    return currentRole === 'owner' || user.id === currentUserId || user.role === 'member';
  }

  function openEditor(user: TenantUserSummary) {
    setEditingUser(user);
    setEditEmail(user.email);
    setEditPassword('');
    setEditRole(user.role);
    setEditStatus(user.status);
  }

  async function saveUser() {
    if (!editingUser) return;
    setEditing(true);
    setMessage('');
    try {
      const input = {
        email: editEmail.trim(),
        ...(editPassword ? { password: editPassword } : {}),
        ...(editingUser.id === currentUserId ? {} : { role: editRole, status: editStatus }),
      };
      const updated = await updateTenantUser(tenantId, editingUser.id, input);
      setUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditingUser(null);
      setEditPassword('');
      setMessage('用户已更新');
    } catch (err) {
      setMessage(`编辑用户失败：${(err as Error).message}`);
    } finally {
      setEditing(false);
    }
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
              <TableHead className="w-20 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              return (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    {user.email}
                    {user.id === currentUserId && <Badge variant="outline" className="ml-2">我</Badge>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{user.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.status === 'active' ? 'secondary' : 'destructive'}>{user.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(user.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" disabled={!canEditUser(user)} onClick={() => openEditor(user)}>
                      <Pencil className="h-4 w-4" />
                      编辑
                    </Button>
                  </TableCell>
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
            <Select value={newRole} disabled={currentRole === 'admin'} onValueChange={(value) => setNewRole(value as TenantUserRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                {currentRole === 'owner' && <SelectItem value="admin">admin</SelectItem>}
                {currentRole === 'owner' && <SelectItem value="owner">owner</SelectItem>}
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

      <Dialog open={Boolean(editingUser)} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑用户</DialogTitle>
            <DialogDescription>留空密码表示不重置；重置密码会让该用户已有的登录续期凭证立即失效。</DialogDescription>
          </DialogHeader>
          {editingUser && (
            <div className="grid gap-3">
              <Input type="email" placeholder="邮箱" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} />
              <Input type="password" placeholder="新密码（留空不修改）" value={editPassword} onChange={(event) => setEditPassword(event.target.value)} />
              <Select value={editRole} disabled={editingUser.id === currentUserId || currentRole === 'admin'} onValueChange={(value) => setEditRole(value as TenantUserRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="owner">owner</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <div className="text-sm font-medium">账号状态</div>
                  <div className="text-xs text-muted-foreground">禁用后不能登录或刷新会话</div>
                </div>
                <Switch
                  checked={editStatus === 'active'}
                  disabled={editingUser.id === currentUserId}
                  onCheckedChange={(checked) => setEditStatus(checked ? 'active' : 'disabled')}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingUser(null)}>取消</Button>
            <Button onClick={() => void saveUser()} disabled={editing || !editEmail.trim()}>
              {editing ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
