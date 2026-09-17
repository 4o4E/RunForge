import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Save, Trash2 } from 'lucide-react';
import type { BusinessPluginAdminItem } from '@runforge/contracts';
import type { BusinessPluginControlApi } from '@/businessPluginControlApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useNotifications } from '@/components/GlobalNotifications';
import { cn } from '@/lib/utils';

export function BusinessPluginManagementPanel({ api }: { api: BusinessPluginControlApi }) {
  const { notify } = useNotifications();
  const [plugins, setPlugins] = useState<BusinessPluginAdminItem[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [configText, setConfigText] = useState('{}');
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selected = useMemo(
    () => plugins?.find((plugin) => plugin.id === selectedId) ?? plugins?.[0] ?? null,
    [plugins, selectedId],
  );

  useEffect(() => {
    let canceled = false;
    api.get()
      .then((view) => {
        if (canceled) return;
        setPlugins(view.plugins);
        setSelectedId((current) => current || view.plugins[0]?.id || '');
      })
      .catch((reason) => !canceled && setError((reason as Error).message));
    return () => { canceled = true; };
  }, [api]);

  useEffect(() => {
    setConfigText(JSON.stringify(selected?.config ?? {}, null, 2));
    setSecretDrafts({});
    setClearSecrets(new Set());
    setError('');
  }, [selected?.id, selected?.contentHash, selected?.config]);

  async function reload() {
    setBusy(true);
    setError('');
    try {
      const view = await api.reload();
      setPlugins(view.plugins);
      setSelectedId((current) => view.plugins.some((plugin) => plugin.id === current) ? current : view.plugins[0]?.id || '');
      notify({ variant: 'success', title: '业务插件目录已重新加载' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!selected) return;
    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(configText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是 JSON 对象');
      config = parsed as Record<string, unknown>;
    } catch (reason) {
      setError(`配置 JSON 无效：${(reason as Error).message}`);
      return;
    }
    const secrets: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(secretDrafts)) if (value) secrets[key] = value;
    for (const key of clearSecrets) secrets[key] = null;

    setBusy(true);
    setError('');
    try {
      const view = await api.update({ plugins: { [selected.id]: { config } }, secrets });
      setPlugins(view.plugins);
      setSecretDrafts({});
      setClearSecrets(new Set());
      notify({ variant: 'success', title: '业务插件配置已保存' });
    } catch (reason) {
      setError((reason as Error).message);
      notify({ variant: 'error', title: '业务插件配置保存失败', description: (reason as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!plugins) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{error || '正在读取业务插件...'}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">业务插件</h2>
          <p className="mt-1 text-sm text-muted-foreground">配置 tenant 级非敏感参数和统一 Secret；空间只负责选择是否启用。</p>
        </div>
        <Button variant="outline" onClick={() => void reload()} disabled={busy}>
          <RefreshCw className="h-4 w-4" />重新加载目录
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card className="min-h-0 overflow-y-auto rounded-lg shadow-sm">
          <CardContent className="grid gap-2 p-3">
            {plugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                onClick={() => setSelectedId(plugin.id)}
                className={cn('grid gap-1 rounded-md border p-3 text-left', selected?.id === plugin.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/60')}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{plugin.displayName}</span>
                  <Badge variant={plugin.ready ? 'default' : 'destructive'}>{plugin.ready ? '可用' : '待配置'}</Badge>
                </span>
                <span className="truncate text-xs text-muted-foreground">{plugin.id}</span>
              </button>
            ))}
            {!plugins.length && <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">当前 tenant 目录没有业务插件。</div>}
          </CardContent>
        </Card>

        {selected ? (
          <Card className="min-h-0 overflow-y-auto rounded-lg shadow-sm">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{selected.displayName}</CardTitle>
                  <CardDescription>{selected.description}</CardDescription>
                </div>
                <Button onClick={() => void save()} disabled={busy}><Save className="h-4 w-4" />保存</Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-5">
              {error && <div className="text-sm text-destructive">{error}</div>}
              {selected.error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{selected.error}</div>}
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div>版本：{selected.version ?? '未声明'}</div>
                <div className="truncate" title={selected.contentHash}>内容 hash：{selected.contentHash.slice(0, 16)}…</div>
                <div>Skills：{selected.skills.map((skill) => skill.id).join(', ') || '无'}</div>
                <div>MCP：{selected.mcpServers.map((server) => server.id).join(', ') || '无'}</div>
                <div>运行资源：{selected.resources.map((resource) => resource.type).join(', ') || '无'}</div>
              </div>

              <label className="grid gap-2 text-sm font-medium">
                <span>tenant 非敏感配置（JSON）</span>
                <Textarea className="min-h-48 font-mono text-xs" value={configText} onChange={(event) => setConfigText(event.target.value)} />
                <span className="text-xs font-normal text-muted-foreground">Schema：{JSON.stringify(selected.configSchema)}</span>
              </label>

              <div className="grid gap-3">
                <div>
                  <div className="text-sm font-medium">Tenant Secret</div>
                  <div className="text-xs text-muted-foreground">输入框不会回显当前值；留空表示不变，清除按钮会删除当前值。</div>
                </div>
                {selected.secrets.map((secret) => (
                  <div key={secret.key} className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">{secret.key}</div>
                        <div className="text-xs text-muted-foreground">{secret.description || '无描述'} · {secret.access.join(', ')}</div>
                      </div>
                      <Badge variant={clearSecrets.has(secret.key) || !secret.configured ? 'outline' : 'secondary'}>
                        {clearSecrets.has(secret.key) || !secret.configured ? '未配置' : '已配置'}
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={secretDrafts[secret.key] ?? ''}
                        placeholder={secret.configured && !clearSecrets.has(secret.key) ? '留空保持当前值' : '输入新值'}
                        onChange={(event) => {
                          setSecretDrafts({ ...secretDrafts, [secret.key]: event.target.value });
                          setClearSecrets((current) => {
                            const next = new Set(current);
                            next.delete(secret.key);
                            return next;
                          });
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`清除 ${secret.key}`}
                        onClick={() => {
                          setSecretDrafts({ ...secretDrafts, [secret.key]: '' });
                          setClearSecrets((current) => new Set(current).add(secret.key));
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                {!selected.secrets.length && <div className="text-sm text-muted-foreground">该业务插件没有声明长期 Secret。</div>}
              </div>
            </CardContent>
          </Card>
        ) : <div className="flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">选择一个业务插件</div>}
      </div>
    </div>
  );
}
