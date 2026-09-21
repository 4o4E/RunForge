import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import type { BusinessPluginAdminItem, BusinessPluginMcpToolView } from '@runforge/contracts';
import Form from '@rjsf/shadcn';
import type { RJSFSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import type { BusinessPluginControlApi } from '@/businessPluginControlApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useNotifications } from '@/components/GlobalNotifications';
import { MarkdownContent } from '@/components/MarkdownContent';
import { cn } from '@/lib/utils';

interface McpToolsState {
  loading: boolean;
  tools?: BusinessPluginMcpToolView[];
  error?: string;
}

function hasConfigEntries(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  return Boolean(
    properties
    && typeof properties === 'object'
    && !Array.isArray(properties)
    && Object.keys(properties).length,
  );
}

export function BusinessPluginManagementPanel({ api }: { api: BusinessPluginControlApi }) {
  const { notify } = useNotifications();
  const [plugins, setPlugins] = useState<BusinessPluginAdminItem[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());
  const [mcpTools, setMcpTools] = useState<Record<string, McpToolsState>>({});
  const [uninstallTarget, setUninstallTarget] = useState<BusinessPluginAdminItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const archiveInputRef = useRef<HTMLInputElement>(null);

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
    setConfig(structuredClone(selected?.config ?? {}));
    setSecretDrafts({});
    setClearSecrets(new Set());
    setMcpTools({});
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

  async function loadMcpTools(pluginId: string, serverId: string, reload = false) {
    const key = `${pluginId}\u0000${serverId}`;
    const current = mcpTools[key];
    if (!reload && (current?.loading || current?.tools)) return;
    setMcpTools((states) => ({ ...states, [key]: { loading: true } }));
    try {
      const result = await api.loadMcpTools(pluginId, serverId);
      setMcpTools((states) => ({ ...states, [key]: { loading: false, tools: result.tools } }));
    } catch (reason) {
      setMcpTools((states) => ({
        ...states,
        [key]: { loading: false, error: (reason as Error).message },
      }));
    }
  }

  async function importArchive(file: File) {
    setBusy(true);
    setError('');
    try {
      const result = await api.importArchive(file);
      setPlugins(result.view.plugins);
      setSelectedId(result.pluginId);
      notify({
        variant: 'success',
        title: result.replaced ? '业务插件已更新' : '业务插件已导入',
        description: result.warnings.length
          ? `${result.pluginId}；${result.warnings.join('；')}`
          : result.pluginId,
      });
    } catch (reason) {
      const message = (reason as Error).message;
      setError(message);
      notify({ variant: 'error', title: '业务插件导入失败', description: message });
    } finally {
      setBusy(false);
      if (archiveInputRef.current) archiveInputRef.current.value = '';
    }
  }

  async function uninstall() {
    if (!uninstallTarget) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.uninstall(uninstallTarget.id);
      setPlugins(result.view.plugins);
      setSelectedId(result.view.plugins[0]?.id ?? '');
      setUninstallTarget(null);
      notify({
        variant: 'success',
        title: '业务插件已卸载',
        description: result.affectedSpaces.length
          ? `已从 ${result.affectedSpaces.length} 个空间移除`
          : '没有空间使用该插件',
      });
    } catch (reason) {
      const message = (reason as Error).message;
      setError(message);
      notify({ variant: 'error', title: '业务插件卸载失败', description: message });
    } finally {
      setBusy(false);
    }
  }

  if (!plugins) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{error || '正在读取业务插件...'}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">业务插件</h2>
        <div className="flex shrink-0 gap-2">
          <input
            ref={archiveInputRef}
            className="hidden"
            type="file"
            accept=".zip,.tgz,.tar.gz,application/zip,application/gzip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importArchive(file);
            }}
          />
          <Button variant="outline" onClick={() => archiveInputRef.current?.click()} disabled={busy}>
            <Upload className="h-4 w-4" />导入压缩包
          </Button>
          <Button variant="outline" onClick={() => void reload()} disabled={busy}>
            <RefreshCw className="h-4 w-4" />重新加载目录
          </Button>
        </div>
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
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setUninstallTarget(selected)} disabled={busy}>
                    <Trash2 className="h-4 w-4" />卸载
                  </Button>
                  <Button onClick={() => void save()} disabled={busy}><Save className="h-4 w-4" />保存</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-5">
              {error && <div className="text-sm text-destructive">{error}</div>}
              {selected.error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{selected.error}</div>}
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div>版本：{selected.version ?? '未声明'}</div>
                <div className="truncate" title={selected.contentHash}>内容 hash：{selected.contentHash.slice(0, 16)}…</div>
                <div>运行资源：{selected.resources.map((resource) => resource.type).join(', ') || '无'}</div>
              </div>

              {!!selected.skills.length && <div className="grid gap-3">
                <div className="text-sm font-medium">Skill</div>
                {selected.skills.map((skill) => (
                  <Collapsible key={skill.id} className="rounded-md border">
                    <CollapsibleTrigger className="group flex w-full items-start justify-between gap-3 p-3 text-left">
                      <span className="grid gap-1">
                        <span className="text-sm font-medium">{skill.name}</span>
                        <span className="text-xs text-muted-foreground">{skill.description}</span>
                      </span>
                      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="border-t px-4 py-3">
                      <div className="mb-2 text-xs text-muted-foreground">入口：{skill.path}/SKILL.md</div>
                      <MarkdownContent text={skill.content || '（入口正文为空）'} />
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>}

              {!!selected.mcpServers.length && <div className="grid gap-3">
                <div className="text-sm font-medium">MCP</div>
                {selected.mcpServers.map((server) => {
                  const toolsKey = `${selected.id}\u0000${server.id}`;
                  const state = mcpTools[toolsKey];
                  return (
                    <Collapsible
                      key={server.id}
                      className="rounded-md border"
                      onOpenChange={(open) => { if (open) void loadMcpTools(selected.id, server.id); }}
                    >
                      <CollapsibleTrigger className="group flex w-full items-start justify-between gap-3 p-3 text-left">
                        <span className="grid gap-1">
                          <span className="text-sm font-medium">{server.label}</span>
                          <span className="text-xs text-muted-foreground">{server.description}</span>
                        </span>
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="grid gap-3 border-t px-4 py-3">
                        <div className="grid gap-1 rounded bg-muted/40 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                          <div>协议：Streamable HTTP</div>
                          <div>地址：{server.url ?? `配置项 ${server.urlConfigKey}`}</div>
                          <div>Bearer Secret：{server.bearerSecretKey ?? '无'}</div>
                          <div>超时：{server.timeoutMs} ms</div>
                          <div>最大工具输出：{server.maxOutput}</div>
                          <div>Headers：{server.headers.length || '无'}</div>
                          {server.headers.map((header) => (
                            <div key={`${header.name}:${header.secretKey ?? header.value}`} className="sm:col-span-2">
                              {header.name}：{header.secretKey ? `Secret ${header.secretKey}` : header.value}
                            </div>
                          ))}
                        </div>

                        {state?.loading && <div className="text-sm text-muted-foreground">正在读取 MCP 工具目录...</div>}
                        {state?.error && (
                          <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                            <span>{state.error}</span>
                            <Button className="w-fit" size="sm" variant="outline" onClick={() => void loadMcpTools(selected.id, server.id, true)}>
                              重新读取
                            </Button>
                          </div>
                        )}
                        {state?.tools?.map((tool) => (
                          <Collapsible key={tool.name} className="rounded-md border bg-background">
                            <CollapsibleTrigger className="group flex w-full items-start justify-between gap-3 p-3 text-left">
                              <span className="grid gap-1">
                                <span className="font-mono text-sm font-medium">{tool.name}</span>
                                <span className="whitespace-pre-wrap text-xs text-muted-foreground">{tool.description || '无描述'}</span>
                              </span>
                              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                            </CollapsibleTrigger>
                            <CollapsibleContent className="border-t px-3 py-2">
                              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                                {JSON.stringify(tool.inputSchema, null, 2)}
                              </pre>
                            </CollapsibleContent>
                          </Collapsible>
                        ))}
                        {state?.tools && !state.tools.length && <div className="text-sm text-muted-foreground">该 MCP 没有返回工具。</div>}
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>}

              {hasConfigEntries(selected.configSchema) && <div className="grid gap-3">
                <div className="text-sm font-medium">普通配置</div>
                  <Form
                    schema={selected.configSchema as RJSFSchema}
                    formData={config}
                    validator={validator}
                    disabled={busy}
                    noHtml5Validate
                    showErrorList={false}
                    uiSchema={{ 'ui:submitButtonOptions': { norender: true } }}
                    onChange={(event) => setConfig((event.formData ?? {}) as Record<string, unknown>)}
                  >
                    <></>
                  </Form>
              </div>}

              {!!selected.secrets.length && <div className="grid gap-3">
                <div className="text-sm font-medium">Secret</div>
                {selected.secrets.map((secret) => (
                  <div key={secret.key} className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">{secret.key}</div>
                        <div className="text-xs text-muted-foreground">{secret.description || '无描述'}</div>
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
              </div>}
            </CardContent>
          </Card>
        ) : <div className="flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">选择一个业务插件</div>}
      </div>

      <Dialog open={Boolean(uninstallTarget)} onOpenChange={(open) => { if (!open && !busy) setUninstallTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>卸载业务插件</DialogTitle>
            <DialogDescription>
              将卸载 {uninstallTarget?.displayName}，从当前租户的全部有效空间移除，并删除该插件的普通配置。租户 Secret 和历史运行快照会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)} disabled={busy}>取消</Button>
            <Button variant="destructive" onClick={() => void uninstall()} disabled={busy}>
              {busy ? '正在卸载...' : '确认卸载'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
