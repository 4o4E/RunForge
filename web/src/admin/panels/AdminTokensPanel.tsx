import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { createApiToken, listApiTokens, revokeApiToken } from '../../api';
import type { ApiTokenSummary } from '@runforge/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function AdminTokensPanel({ tenantId }: { tenantId: string }) {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [mintedToken, setMintedToken] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const result = await listApiTokens(tenantId);
      setTokens(result.tokens);
    } catch (err) {
      setMessage(`读取 token 列表失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [tenantId]);

  async function createToken() {
    setCreating(true);
    setMessage('');
    try {
      const created = await createApiToken(tenantId, { label: label.trim() || undefined });
      setMintedToken(created.token);
      setLabel('');
      await refresh();
    } catch (err) {
      setMessage(`创建 token 失败：${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: ApiTokenSummary) {
    setMessage('');
    try {
      await revokeApiToken(tenantId, token.id);
      await refresh();
    } catch (err) {
      setMessage(`吊销 token 失败：${(err as Error).message}`);
    }
  }

  function closeDialog() {
    setCreateOpen(false);
    setMintedToken('');
  }

  return (
    <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">API Token</CardTitle>
            <CardDescription>{tokens.length} 个 token，用于自动化调用</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {message && <span className="max-w-md truncate text-sm text-muted-foreground">{message}</span>}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建 Token
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>备注</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>过期时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium">{token.label ?? '（无备注）'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(token.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{token.expiresAt ? new Date(token.expiresAt).toLocaleString() : '永不过期'}</TableCell>
                <TableCell>
                  {token.revokedAt ? <Badge variant="secondary">已吊销</Badge> : <Badge>有效</Badge>}
                </TableCell>
                <TableCell>
                  {!token.revokedAt && (
                    <Button variant="outline" size="sm" onClick={() => void revoke(token)}>
                      <Trash2 className="h-4 w-4" />
                      吊销
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={createOpen} onOpenChange={(open) => (open ? setCreateOpen(true) : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 API Token</DialogTitle>
            <DialogDescription>明文 token 只在创建时显示一次，请立刻复制保存。</DialogDescription>
          </DialogHeader>
          {mintedToken ? (
            <div className="grid gap-2">
              <Input readOnly value={mintedToken} onFocus={(event) => event.currentTarget.select()} />
              <p className="text-xs text-muted-foreground">关闭此弹窗后将不再显示明文，请确认已复制。</p>
            </div>
          ) : (
            <Input placeholder="备注（可选）" value={label} onChange={(event) => setLabel(event.target.value)} />
          )}
          <DialogFooter>
            {mintedToken ? (
              <Button onClick={closeDialog}>完成</Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeDialog}>取消</Button>
                <Button onClick={() => void createToken()} disabled={creating}>
                  {creating ? '创建中…' : '创建'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
