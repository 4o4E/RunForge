import { useEffect, useState } from 'react';
import type { ExternalCallerSummary, ExternalTokenSummary, SpaceSummary } from '@runforge/contracts';
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ExternalCallerWithTokens, SpaceControlApi } from '@/spaceControlApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

function localExpiryToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function tokenStatus(token: ExternalTokenSummary): { label: string; variant: 'default' | 'secondary' | 'destructive' } {
  if (token.revokedAt) return { label: '已吊销', variant: 'secondary' };
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return { label: '已过期', variant: 'destructive' };
  return { label: '有效', variant: 'default' };
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('metadata 必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function SecretView({ token }: { token: string }) {
  const endpoint = `${window.location.origin}/api/external/${token}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2">
      <Input readOnly value={token} onFocus={(event) => event.currentTarget.select()} />
      <div className="flex items-center gap-2">
        <Input readOnly value={endpoint} onFocus={(event) => event.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void navigator.clipboard.writeText(endpoint).then(() => setCopied(true))}
          title="复制外部入口 URL"
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">UUID 明文只显示一次。URL 同时是入口和秘密凭证，请立即交给可信应用 SDK 保存。</p>
      {copied && <p className="text-xs text-foreground">已复制入口 URL。</p>}
    </div>
  );
}

export function ExternalCallersPanel({ api, space }: { api: SpaceControlApi; space: SpaceSummary }) {
  const [callers, setCallers] = useState<ExternalCallerWithTokens[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [callerName, setCallerName] = useState('');
  const [callerMetadata, setCallerMetadata] = useState('{}');
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenExpiry, setTokenExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [mintedToken, setMintedToken] = useState('');
  const [issueCaller, setIssueCaller] = useState<ExternalCallerSummary | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [pendingCallerId, setPendingCallerId] = useState<string | null>(null);
  const [pendingTokenId, setPendingTokenId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const result = await api.listCallers(space.id);
      setCallers(result.callers);
      setMessage('');
    } catch (error) {
      setMessage(`读取调用方失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [api, space.id]);

  function resetTokenForm() {
    setTokenLabel('');
    setTokenExpiry('');
    setMintedToken('');
  }

  function closeCreate() {
    setCreateOpen(false);
    setCallerName('');
    setCallerMetadata('{}');
    resetTokenForm();
  }

  async function createCaller() {
    setCreating(true);
    setMessage('');
    try {
      const created = await api.createCaller(space.id, {
        name: callerName.trim(),
        metadata: parseMetadata(callerMetadata),
        tokenLabel: tokenLabel.trim() || null,
        tokenExpiresAt: localExpiryToIso(tokenExpiry),
      });
      setMintedToken(created.token.token);
      await refresh();
    } catch (error) {
      setMessage(`创建调用方失败：${(error as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function issueToken() {
    if (!issueCaller) return;
    setIssuing(true);
    setMessage('');
    try {
      const created = await api.issueToken(space.id, issueCaller.id, {
        label: tokenLabel.trim() || null,
        expiresAt: localExpiryToIso(tokenExpiry),
      });
      setMintedToken(created.token);
      await refresh();
    } catch (error) {
      setMessage(`签发 Token 失败：${(error as Error).message}`);
    } finally {
      setIssuing(false);
    }
  }

  async function toggleCaller(caller: ExternalCallerSummary) {
    const disabling = caller.status === 'active';
    if (disabling && pendingCallerId !== caller.id) {
      setPendingCallerId(caller.id);
      return;
    }
    setPendingCallerId(null);
    try {
      await api.updateCaller(space.id, caller.id, { status: disabling ? 'disabled' : 'active' });
      await refresh();
    } catch (error) {
      setMessage(`更新调用方失败：${(error as Error).message}`);
    }
  }

  async function revokeToken(callerId: string, token: ExternalTokenSummary) {
    if (pendingTokenId !== token.id) {
      setPendingTokenId(token.id);
      return;
    }
    setPendingTokenId(null);
    try {
      await api.revokeToken(space.id, callerId, token.id);
      await refresh();
    } catch (error) {
      setMessage(`吊销 Token 失败：${(error as Error).message}`);
    }
  }

  return (
    <div className="grid gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">外部调用方与 UUID Token</h3>
          <p className="text-xs text-muted-foreground">每个可信应用使用独立调用方和 Token，可单独禁用、吊销和轮换。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />刷新
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-4" />新建调用方</Button>
        </div>
      </div>
      {message && <div className="text-sm text-destructive">{message}</div>}
      {callers.length === 0 && !loading && <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">还没有外部调用方。</div>}
      {callers.map(({ caller, tokens }) => (
        <div key={caller.id} className="grid gap-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{caller.name}</div>
              <div className="truncate text-xs text-muted-foreground" title={caller.id}>{caller.id}</div>
            </div>
            <Badge variant={caller.status === 'active' ? 'secondary' : 'destructive'}>{caller.status}</Badge>
            <Button variant="outline" size="sm" onClick={() => void toggleCaller(caller)}>
              {caller.status === 'active' && pendingCallerId === caller.id ? '确认禁用' : caller.status === 'active' ? '禁用' : '启用'}
            </Button>
            <Button
              size="sm"
              disabled={caller.status !== 'active'}
              onClick={() => {
                resetTokenForm();
                setIssueCaller(caller);
              }}
            >
              <KeyRound className="size-4" />签发 Token
            </Button>
          </div>
          {Object.keys(caller.metadata).length > 0 && (
            <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-xs text-muted-foreground">{JSON.stringify(caller.metadata, null, 2)}</pre>
          )}
          <div className="grid gap-2">
            {tokens.map((token) => {
              const status = tokenStatus(token);
              return (
                <div key={token.id} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/25 px-3 py-2 text-xs">
                  <span className="font-medium">{token.label ?? '无备注'}</span>
                  <Badge variant={status.variant}>{status.label}</Badge>
                  <span className="text-muted-foreground">创建 {new Date(token.createdAt).toLocaleString()}</span>
                  <span className="text-muted-foreground">到期 {token.expiresAt ? new Date(token.expiresAt).toLocaleString() : '永不过期'}</span>
                  <span className="text-muted-foreground">最后使用 {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : '从未'}</span>
                  {!token.revokedAt && status.label === '有效' && (
                    <Button className="ml-auto" variant="outline" size="sm" onClick={() => void revokeToken(caller.id, token)}>
                      <Trash2 className="size-3.5" />{pendingTokenId === token.id ? '确认吊销' : '吊销'}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <Dialog open={createOpen} onOpenChange={(open) => (open ? setCreateOpen(true) : closeCreate())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建外部调用方</DialogTitle>
            <DialogDescription>创建调用方时同时签发第一个 UUID Token，明文只显示一次。</DialogDescription>
          </DialogHeader>
          {mintedToken ? <SecretView token={mintedToken} /> : (
            <div className="grid gap-3">
              <Input placeholder="调用方名称" value={callerName} onChange={(event) => setCallerName(event.target.value)} />
              <Textarea className="min-h-24 font-mono text-xs" value={callerMetadata} onChange={(event) => setCallerMetadata(event.target.value)} placeholder="metadata JSON 对象" />
              <Input placeholder="Token 备注（可选）" value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} />
              <label className="grid gap-1 text-xs text-muted-foreground">过期时间（可选）<Input type="datetime-local" value={tokenExpiry} onChange={(event) => setTokenExpiry(event.target.value)} /></label>
            </div>
          )}
          <DialogFooter>
            {mintedToken ? <Button onClick={closeCreate}>完成</Button> : (
              <><Button variant="outline" onClick={closeCreate}>取消</Button><Button disabled={creating || !callerName.trim()} onClick={() => void createCaller()}>{creating ? '创建中…' : '创建'}</Button></>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(issueCaller)} onOpenChange={(open) => {
        if (!open) {
          setIssueCaller(null);
          resetTokenForm();
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>签发 UUID Token</DialogTitle>
            <DialogDescription>{issueCaller?.name} 的新 Token 不会让旧 Token 自动失效；确认接入完成后再单独吊销旧 Token。</DialogDescription>
          </DialogHeader>
          {mintedToken ? <SecretView token={mintedToken} /> : (
            <div className="grid gap-3">
              <Input placeholder="备注（可选）" value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} />
              <label className="grid gap-1 text-xs text-muted-foreground">过期时间（可选）<Input type="datetime-local" value={tokenExpiry} onChange={(event) => setTokenExpiry(event.target.value)} /></label>
            </div>
          )}
          <DialogFooter>
            {mintedToken ? <Button onClick={() => { setIssueCaller(null); resetTokenForm(); }}>完成</Button> : (
              <><Button variant="outline" onClick={() => setIssueCaller(null)}>取消</Button><Button disabled={issuing} onClick={() => void issueToken()}>{issuing ? '签发中…' : '签发'}</Button></>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
