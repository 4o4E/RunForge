import { useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { TenantUserRole, TenantUserSummary, UpdateUserInput } from '@runforge/contracts';
import type { TenantUsersControlApi } from '@/tenantUsersControlApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export type TenantUsersActor =
  | { kind: 'system' }
  | { kind: 'tenant'; userId: string; role: TenantUserRole };

function isCurrentUser(actor: TenantUsersActor, user: TenantUserSummary): boolean {
  return actor.kind === 'tenant' && actor.userId === user.id;
}

function canAssignAdminRoles(actor: TenantUsersActor): boolean {
  return actor.kind === 'system' || actor.role === 'owner';
}

function canEditUser(actor: TenantUsersActor, user: TenantUserSummary): boolean {
  if (actor.kind === 'system' || actor.role === 'owner') return true;
  return actor.userId === user.id || user.role === 'member';
}

function canDeleteUser(actor: TenantUsersActor, user: TenantUserSummary, users: readonly TenantUserSummary[]): boolean {
  if (user.isDefaultAdmin) return false;
  if (user.role === 'owner' && users.filter((candidate) => candidate.role === 'owner').length === 1) return false;
  if (actor.kind === 'system' || actor.role === 'owner') return true;
  return user.role === 'member';
}

export function TenantUsersPanel({ api, actor }: { api: TenantUsersControlApi; actor: TenantUsersActor }) {
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
  const [deleteTarget, setDeleteTarget] = useState<TenantUserSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const result = await api.list();
      setUsers(result.users);
      setMessage('');
    } catch (error) {
      setMessage(`读取用户列表失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [api]);

  async function createUser() {
    setCreating(true);
    setMessage('');
    try {
      await api.create({ email: newEmail.trim(), password: newPassword, role: newRole });
      setCreateOpen(false);
      setNewEmail('');
      setNewPassword('');
      setNewRole('member');
      await refresh();
    } catch (error) {
      setMessage(`创建用户失败：${(error as Error).message}`);
    } finally {
      setCreating(false);
    }
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
      const input: UpdateUserInput = {
        email: editEmail.trim(),
        ...(editPassword ? { password: editPassword } : {}),
        ...(isCurrentUser(actor, editingUser) ? {} : { role: editRole, status: editStatus }),
      };
      const updated = await api.update(editingUser.id, input);
      setUsers((current) => current.map((user) => (user.id === updated.id ? updated : user)));
      setEditingUser(null);
      setEditPassword('');
      setMessage('用户已更新');
    } catch (error) {
      setMessage(`编辑用户失败：${(error as Error).message}`);
    } finally {
      setEditing(false);
    }
  }

  async function deleteUser() {
    if (!deleteTarget) return;
    setDeleting(true);
    setMessage('');
    try {
      await api.delete(deleteTarget.id);
      setUsers((current) => current.filter((user) => user.id !== deleteTarget.id));
      setDeleteTarget(null);
      setEditingUser(null);
      setMessage('用户已永久删除');
    } catch (error) {
      setMessage(`删除用户失败：${(error as Error).message}`);
    } finally {
      setDeleting(false);
    }
  }

  const privilegedRolesEnabled = canAssignAdminRoles(actor);

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
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">
                  {user.email}
                  {isCurrentUser(actor, user) && <Badge variant="outline" className="ml-2">我</Badge>}
                  {user.isDefaultAdmin && <Badge variant="outline" className="ml-2">默认管理员</Badge>}
                </TableCell>
                <TableCell><Badge variant="outline">{user.role}</Badge></TableCell>
                <TableCell>
                  <Badge variant={user.status === 'active' ? 'secondary' : 'destructive'}>{user.status}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(user.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" disabled={!canEditUser(actor, user)} onClick={() => openEditor(user)}>
                    <Pencil className="h-4 w-4" />
                    编辑
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>
              {privilegedRolesEnabled ? '可以创建 owner、admin 或 member 账号。' : 'admin 只能创建 member 账号。'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input type="email" placeholder="邮箱" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
            <Input type="password" placeholder="密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            <Select value={newRole} disabled={!privilegedRolesEnabled} onValueChange={(value) => setNewRole(value as TenantUserRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                {privilegedRolesEnabled && <SelectItem value="admin">admin</SelectItem>}
                {privilegedRolesEnabled && <SelectItem value="owner">owner</SelectItem>}
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
              <Select
                value={editRole}
                disabled={isCurrentUser(actor, editingUser) || !privilegedRolesEnabled}
                onValueChange={(value) => setEditRole(value as TenantUserRole)}
              >
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
                  disabled={isCurrentUser(actor, editingUser)}
                  onCheckedChange={(checked) => setEditStatus(checked ? 'active' : 'disabled')}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            {editingUser && canDeleteUser(actor, editingUser, users) && (
              <Button
                variant="destructive"
                className="mr-auto"
                onClick={() => {
                  setDeleteTarget(editingUser);
                  setEditingUser(null);
                }}
              >
                <Trash2 className="h-4 w-4" />永久删除
              </Button>
            )}
            <Button variant="outline" onClick={() => setEditingUser(null)}>取消</Button>
            <Button onClick={() => void saveUser()} disabled={editing || !editEmail.trim()}>
              {editing ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>永久删除用户</DialogTitle>
            <DialogDescription>将永久删除 {deleteTarget?.email} 的账号和登录凭证。存在关联对话或执行空间时会拒绝删除。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={() => void deleteUser()} disabled={deleting}>
              {deleting ? '删除中…' : '永久删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
