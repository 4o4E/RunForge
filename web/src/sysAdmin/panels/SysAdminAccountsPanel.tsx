import { useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { createSystemAdminAccount, listSystemAdminAccounts } from '../../sysAdminApi';
import type { SystemAdminSummary } from '@runforge/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function SysAdminAccountsPanel() {
  const [admins, setAdmins] = useState<SystemAdminSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const result = await listSystemAdminAccounts();
      setAdmins(result.admins);
    } catch (err) {
      setMessage(`读取系统管理员列表失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createAdmin() {
    setCreating(true);
    setMessage('');
    try {
      await createSystemAdminAccount({ email: email.trim(), password });
      setCreateOpen(false);
      setEmail('');
      setPassword('');
      await refresh();
    } catch (err) {
      setMessage(`创建系统管理员失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">系统管理员</CardTitle>
            <CardDescription>{admins.length} 个账号，能管理所有租户</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {message && <span className="max-w-md truncate text-sm text-muted-foreground">{message}</span>}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建账号
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>邮箱</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.map((admin) => (
              <TableRow key={admin.id}>
                <TableCell className="font-medium">{admin.email}</TableCell>
                <TableCell><Badge variant={admin.status === 'active' ? 'default' : 'secondary'}>{admin.status}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(admin.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建系统管理员</DialogTitle>
            <DialogDescription>系统管理员能管理所有租户，请谨慎分发账号。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input type="email" placeholder="邮箱" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Input type="password" placeholder="密码" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={() => void createAdmin()} disabled={creating || !email.trim() || !password}>
              {creating ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
