import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronRight, MessageSquare, Pencil, Plus, RefreshCw, Save, Trash2, Wifi, X } from 'lucide-react';
import type {
  LlmInputModality,
  LlmModelCapabilitySettings,
  LlmProviderChatTestResult,
  LlmProviderSettings,
  LlmSettings,
  McpServerProbeResult,
  McpServerSettings,
  McpSettings,
  McpToolOption,
} from '@runforge/contracts';
import type { SettingsControlApi } from '../../controlApi';
import { Field } from '../../components/SettingsView';
import { llmOptionsFromSettings, ModelSearchSelect } from '../../components/ModelSearchSelect';
import { useNotifications } from '../../components/GlobalNotifications';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { resolveModelCapability } from './modelCapabilityLookup';

export function PanelShell({ actions, children, description, title }: { actions?: ReactNode; children: ReactNode; description: string; title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function EntityLayout({ children, list }: { children: ReactNode; list: ReactNode }) {
  return (
    <div className="grid h-full min-h-0 items-stretch gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
        <CardContent className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3">{list}</CardContent>
      </Card>
      <div className="h-full min-h-0 overflow-y-auto pr-1">{children}</div>
    </div>
  );
}

export function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1 rounded-md border bg-muted/20 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 break-all text-sm font-medium">{value || '-'}</div>
    </div>
  );
}

function headersToText(rows: Array<{ name: string; value: string }>): string {
  return rows.map((row) => `${row.name}=${row.value}`).join('\n');
}

function textToHeaders(text: string): Array<{ name: string; value: string }> {
  return text
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('=');
      const name = (separator >= 0 ? line.slice(0, separator) : line).trim();
      const value = separator >= 0 ? line.slice(separator + 1) : '';
      return name ? { name, value } : null;
    })
    .filter((row): row is { name: string; value: string } => Boolean(row));
}

function newMcpServer(): McpServerSettings {
  return {
    id: `mcp-${Date.now()}`,
    label: 'MCP Server',
    description: '描述这个 MCP Server 提供的能力。',
    enabled: false,
    url: '',
    bearerToken: '',
    headers: [],
    timeoutMs: 60_000,
    maxOutput: 40_000,
  };
}

export function McpServerSettingsPanel({ controlApi }: { controlApi: SettingsControlApi }) {
  const { notify } = useNotifications();
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [options, setOptions] = useState<McpToolOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<McpServerSettings | null>(null);
  const [probeResult, setProbeResult] = useState<McpServerProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [error, setError] = useState('');

  // 列表只绑定已保存配置；编辑时使用独立 draft，取消不会污染当前生效值。
  useEffect(() => {
    let canceled = false;
    Promise.all([controlApi.getMcpSettings(), controlApi.getMcpSettingsOptions()])
      .then(([nextSettings, nextOptions]) => {
        if (canceled) return;
        setSettings(nextSettings);
        setOptions(nextOptions.tools);
        setSelectedIndex(0);
        setEditIndex(null);
        setDraft(null);
      })
      .catch((err) => !canceled && setError((err as Error).message));
    return () => { canceled = true; };
  }, [controlApi]);

  if (!settings) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{error || '正在读取 MCP 配置...'}</div>;

  const currentSettings = settings;
  const selected = currentSettings.servers[selectedIndex] ?? null;
  const editing = editIndex !== null && draft !== null;
  const originalServerId = editIndex !== null && editIndex < currentSettings.servers.length ? currentSettings.servers[editIndex].id : null;
  const discoveredTools = probeResult?.tools ?? options.filter((tool) => tool.serverId === (draft?.id || selected?.id) || tool.serverId === originalServerId);

  function selectServer(index: number) {
    if (editing) return;
    setSelectedIndex(index);
    setPendingDelete(null);
    setProbeResult(null);
  }

  function beginCreate() {
    setEditIndex(currentSettings.servers.length);
    setDraft(newMcpServer());
    setProbeResult(null);
    setPendingDelete(null);
  }

  function beginEdit() {
    if (!selected) return;
    setEditIndex(selectedIndex);
    setDraft({ ...selected, headers: selected.headers.map((header) => ({ ...header })) });
    setProbeResult(null);
    setPendingDelete(null);
  }

  function cancelEdit() {
    setEditIndex(null);
    setDraft(null);
    setProbeResult(null);
  }

  async function saveDraft() {
    if (!draft || editIndex === null) return;
    setBusy(true);
    setError('');
    try {
      const servers = [...currentSettings.servers];
      if (editIndex >= servers.length) servers.push(draft);
      else servers[editIndex] = draft;
      const next = await controlApi.updateMcpSettings({ servers });
      const nextOptions = await controlApi.getMcpSettingsOptions();
      setSettings(next);
      setOptions(nextOptions.tools);
      setSelectedIndex(Math.min(editIndex, Math.max(0, next.servers.length - 1)));
      setEditIndex(null);
      setDraft(null);
      setProbeResult(null);
      notify({ variant: 'success', title: 'MCP Server 已保存' });
    } catch (err) {
      setError((err as Error).message);
      notify({ variant: 'error', title: 'MCP Server 保存失败', description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function testServer(server: McpServerSettings) {
    setProbing(true);
    try {
      const result = await controlApi.probeMcpServer(server);
      setProbeResult(result);
      notify({ variant: result.ok ? 'success' : 'error', title: result.ok ? 'MCP 连接成功' : 'MCP 连接失败', description: result.message });
    } catch (err) {
      notify({ variant: 'error', title: 'MCP 连接失败', description: (err as Error).message });
    } finally {
      setProbing(false);
    }
  }

  async function deleteSelected() {
    if (!selected || selectedIndex !== pendingDelete) {
      setPendingDelete(selectedIndex);
      return;
    }
    setBusy(true);
    try {
      const next = await controlApi.updateMcpSettings({ servers: currentSettings.servers.filter((_, index) => index !== selectedIndex) });
      setSettings(next);
      setSelectedIndex(Math.min(selectedIndex, Math.max(0, next.servers.length - 1)));
      setPendingDelete(null);
      notify({ variant: 'success', title: 'MCP Server 已删除' });
    } catch (err) {
      notify({ variant: 'error', title: 'MCP Server 删除失败', description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell
      title="MCP Server"
      description="配置可激活的 MCP Server；远端工具不会默认进入模型上下文"
      actions={<Button onClick={beginCreate} disabled={editing || busy}><Plus className="h-4 w-4" />新增 Server</Button>}
    >
      <EntityLayout
        list={currentSettings.servers.length ? currentSettings.servers.map((server, index) => (
          <button
            key={`${server.id}-${index}`}
            type="button"
            disabled={editing}
            onClick={() => selectServer(index)}
            className={cn('grid gap-1 rounded-md border p-3 text-left transition-colors', index === selectedIndex && !editing ? 'border-primary bg-primary/5' : 'hover:bg-accent/60')}
          >
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{server.label || server.id}</span>
              <Badge variant={server.enabled ? 'default' : 'outline'}>{server.enabled ? '启用' : '停用'}</Badge>
            </span>
            <span className="truncate text-xs text-muted-foreground">{server.id}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{server.description}</span>
          </button>
        )) : <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">暂无 MCP Server</div>}
      >
        {editing && draft ? (
          <Card className="rounded-lg shadow-sm">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div><CardTitle>{editIndex! >= currentSettings.servers.length ? '新建 MCP Server' : '编辑 MCP Server'}</CardTitle><CardDescription>保存前只修改草稿，不影响当前生效配置</CardDescription></div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={cancelEdit} disabled={busy}><X className="h-4 w-4" />取消</Button>
                  <Button onClick={() => void saveDraft()} disabled={busy || !draft.id.trim() || !draft.url.trim()}>{busy ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}保存</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              {error && <div className="text-sm text-destructive">{error}</div>}
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Server ID"><Input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field>
                <Field label="显示名称"><Input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field>
                <div className="md:col-span-2"><Field label="能力描述"><Textarea rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field></div>
                <Field label="URL"><Input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></Field>
                <Field label="Bearer Token"><Input type="password" value={draft.bearerToken} onChange={(event) => setDraft({ ...draft, bearerToken: event.target.value })} /></Field>
                <Field label="超时毫秒"><Input type="number" min={1000} value={draft.timeoutMs} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })} /></Field>
                <Field label="结果上限"><Input type="number" min={1000} value={draft.maxOutput} onChange={(event) => setDraft({ ...draft, maxOutput: Number(event.target.value) })} /></Field>
                <div className="md:col-span-2"><Field label="Headers（每行 name=value）"><Textarea rows={4} value={headersToText(draft.headers)} onChange={(event) => setDraft({ ...draft, headers: textToHeaders(event.target.value) })} /></Field></div>
                <div className="flex items-center justify-between rounded-md border p-3 md:col-span-2">
                  <div><div className="text-sm font-medium">启用 Server</div><div className="text-xs text-muted-foreground">启用后只注入 id 和描述；调用 mcp_activate 后才加载工具 schema</div></div>
                  <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div><div className="text-sm font-medium">激活后加载的工具</div><div className="text-xs text-muted-foreground">当前 Server 返回的全部工具会在当前 run 激活后加入请求上下文</div></div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">已发现 {discoveredTools.length}</span>
                  <Button variant="outline" size="sm" onClick={() => void testServer(draft)} disabled={probing}>{probing ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}测试并刷新</Button>
                </div>
              </div>
              <ScrollArea className="rounded-md border" viewportClassName="max-h-72 !h-auto">
                <div className="grid divide-y">
                  {!discoveredTools.length && <div className="p-3 text-sm text-muted-foreground">尚未发现工具，请先测试连接</div>}
                  {discoveredTools.map((tool) => (
                    <div key={`${tool.serverId}:${tool.name}`} className="flex items-start gap-3 p-3">
                      <span className="min-w-0 flex-1"><span className="block break-all text-sm font-medium">{tool.name}</span><span className="block text-xs text-muted-foreground">{tool.description || tool.mappedName}</span></span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        ) : selected ? (
          <Card className="rounded-lg shadow-sm">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div><CardTitle>{selected.label || selected.id}</CardTitle><CardDescription>{selected.id}</CardDescription></div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => void testServer(selected)} disabled={probing}>{probing ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}测试连接</Button>
                  <Button variant="outline" size="sm" onClick={beginEdit}><Pencil className="h-4 w-4" />编辑</Button>
                  <Button variant={pendingDelete === selectedIndex ? 'destructive' : 'outline'} size="sm" onClick={() => void deleteSelected()} disabled={busy}>
                    <Trash2 className="h-4 w-4" />{pendingDelete === selectedIndex ? '确认删除' : '删除'}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <SummaryRow label="状态" value={selected.enabled ? '已启用' : '已停用'} />
                <SummaryRow label="能力描述" value={selected.description} />
                <SummaryRow label="URL" value={selected.url} />
                <SummaryRow label="认证" value={selected.bearerToken ? '已配置 Bearer Token' : '未配置'} />
                <SummaryRow label="Headers" value={`${selected.headers.length} 项`} />
                <SummaryRow label="超时" value={`${selected.timeoutMs} ms`} />
                <SummaryRow label="结果上限" value={selected.maxOutput.toLocaleString()} />
              </div>
              <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">运行时只预注入 Server ID 和能力描述；当前 run 调用 mcp_activate 后，才加载该 Server 返回的全部工具 schema。</div>
            </CardContent>
          </Card>
        ) : <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">选择或新建一个 MCP Server</div>}
      </EntityLayout>
    </PanelShell>
  );
}

const PROTOCOL_OPTIONS: Array<{ value: LlmProviderSettings['protocol']; label: string }> = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

function defaultProvider(index: number, defaultCapability: LlmModelCapabilitySettings): LlmProviderSettings {
  return {
    id: `provider-${index + 1}`,
    label: `供应商 ${index + 1}`,
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    discoveredModels: ['gpt-4o-mini'],
    models: ['gpt-4o-mini'],
    modelCapabilities: [defaultCapability],
    defaultModel: 'gpt-4o-mini',
    timeoutMs: 120_000,
    retries: 2,
  };
}

function providerCandidates(provider: LlmProviderSettings): string[] {
  return [...new Set([...provider.discoveredModels, ...provider.models, provider.defaultModel].map((model) => model.trim()).filter(Boolean))].sort();
}

function modelPrefix(model: string): string {
  const indexes = ['-', ':', '/', '_', '.'].map((separator) => model.indexOf(separator)).filter((index) => index > 0);
  return model.slice(0, indexes.length ? Math.min(...indexes) : model.length) || '其他';
}

function groupModels(models: string[]): Array<{ prefix: string; models: string[] }> {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const prefix = modelPrefix(model);
    groups.set(prefix, [...(groups.get(prefix) ?? []), model]);
  }
  return [...groups.entries()]
    .map(([prefix, rows]) => ({ prefix, models: rows.sort() }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function fallbackCapability(model: string): LlmModelCapabilitySettings {
  return {
    model,
    contextWindow: null,
    contextWindowSource: 'manual',
    compactionThreshold: null,
    compactionThresholdSource: 'manual',
    maxOutputTokens: null,
    inputModalities: [],
    inputModalitiesSource: 'manual',
    references: [],
  };
}

const INPUT_MODALITY_OPTIONS: Array<{ value: LlmInputModality; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'video', label: '视频' },
  { value: 'document', label: '文档' },
];

const CONTEXT_WINDOW_PRESETS = [
  { value: 1_050_000, label: '1.05M · 1,050,000' },
  { value: 1_047_576, label: 'GPT 4.1 · 1,047,576' },
  { value: 1_048_576, label: '1M · 1,048,576' },
  { value: 400_000, label: '400K · 400,000' },
  { value: 262_144, label: '256K · 262,144' },
  { value: 200_000, label: '200K · 200,000' },
  { value: 131_072, label: '128Ki · 131,072' },
  { value: 128_000, label: '128K · 128,000' },
  { value: 65_536, label: '64K · 65,536' },
  { value: 32_768, label: '32K · 32,768' },
  { value: 16_384, label: '16K · 16,384' },
] as const;

function contextWindowPresetValue(contextWindow: number | null): string {
  return CONTEXT_WINDOW_PRESETS.some((preset) => preset.value === contextWindow) ? String(contextWindow) : 'custom';
}

interface ChatTestState {
  provider: LlmProviderSettings;
  model: string;
  input: string;
  result?: LlmProviderChatTestResult;
}

export function LlmProviderSettingsPanel({ controlApi }: { controlApi: SettingsControlApi }) {
  const { notify } = useNotifications();
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<LlmProviderSettings | null>(null);
  const [defaultDraft, setDefaultDraft] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [chatTest, setChatTest] = useState<ChatTestState | null>(null);
  const [modelGroupsOpen, setModelGroupsOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');

  // provider 的选择态和编辑态分离，避免“切换条目”隐式提交尚未保存的表单。
  useEffect(() => {
    let canceled = false;
    controlApi.getLlmSettings()
      .then((next) => {
        if (canceled) return;
        setSettings(next);
        setSelectedIndex(0);
        setEditIndex(null);
        setDraft(null);
      })
      .catch((err) => !canceled && setError((err as Error).message));
    return () => { canceled = true; };
  }, [controlApi]);

  const modelOptions = useMemo(() => settings ? llmOptionsFromSettings(settings) : [], [settings]);
  if (!settings) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{error || '正在读取 LLM 供应商...'}</div>;

  const currentSettings = settings;
  const selected = currentSettings.providers[selectedIndex] ?? null;
  const editing = editIndex !== null && draft !== null;
  const editingModelSelection = defaultDraft !== null || titleDraft !== null;
  const candidates = draft ? providerCandidates(draft) : [];
  const groupedCandidates = groupModels(candidates);

  function setProviderDraft(
    patch: Partial<LlmProviderSettings> | ((current: LlmProviderSettings) => Partial<LlmProviderSettings>),
  ) {
    setDraft((current) => {
      if (!current) return current;
      const resolved = typeof patch === 'function' ? patch(current) : patch;
      const next = { ...current, ...resolved };
      if (resolved.models && !next.models.includes(next.defaultModel)) next.defaultModel = next.models[0] ?? '';
      return next;
    });
  }

  async function beginCreate() {
    setBusyAction('create');
    let capability: LlmModelCapabilitySettings;
    try {
      capability = await resolveModelCapability('gpt-4o-mini');
    } catch (err) {
      capability = fallbackCapability('gpt-4o-mini');
      notify({ variant: 'error', title: '默认模型资料读取失败，请手动填写能力', description: (err as Error).message });
    } finally {
      setBusyAction('');
    }
    setEditIndex(currentSettings.providers.length);
    setDraft(defaultProvider(currentSettings.providers.length, capability));
    setPendingDelete(null);
    setCustomModel('');
  }

  function beginEdit() {
    if (!selected) return;
    setEditIndex(selectedIndex);
    setDraft({
      ...selected,
      discoveredModels: [...selected.discoveredModels],
      models: [...selected.models],
      modelCapabilities: selected.modelCapabilities.map((item) => ({
        ...item,
        inputModalities: [...item.inputModalities],
        references: item.references.map((reference) => ({ ...reference, fields: [...reference.fields] })),
      })),
    });
    setPendingDelete(null);
    setCustomModel('');
  }

  function cancelEdit() {
    setEditIndex(null);
    setDraft(null);
    setCustomModel('');
  }

  async function saveSettings(nextInput: LlmSettings, successTitle: string): Promise<LlmSettings | null> {
    setBusyAction('save');
    setError('');
    try {
      const next = await controlApi.updateLlmSettings(nextInput);
      setSettings(next);
      notify({ variant: 'success', title: successTitle });
      return next;
    } catch (err) {
      setError((err as Error).message);
      notify({ variant: 'error', title: 'LLM 配置保存失败', description: (err as Error).message });
      return null;
    } finally {
      setBusyAction('');
    }
  }

  async function saveProvider() {
    if (!draft || editIndex === null) return;
    const providers = [...currentSettings.providers];
    if (editIndex >= providers.length) providers.push(draft);
    else providers[editIndex] = draft;
    const options = llmOptionsFromSettings({ ...currentSettings, providers });
    const defaultModelRef = options.some((option) => option.ref === currentSettings.defaultModelRef) ? currentSettings.defaultModelRef : options[0]?.ref ?? '';
    const titleModelRef = options.some((option) => option.ref === currentSettings.titleModelRef) ? currentSettings.titleModelRef : defaultModelRef;
    const next = await saveSettings({ providers, defaultModelRef, titleModelRef }, 'LLM 供应商已保存');
    if (!next) return;
    setSelectedIndex(Math.min(editIndex, next.providers.length - 1));
    setEditIndex(null);
    setDraft(null);
  }

  async function saveDefaultModel() {
    if (defaultDraft === null) return;
    const next = await saveSettings({ ...currentSettings, defaultModelRef: defaultDraft }, '默认模型已更新');
    if (next) setDefaultDraft(null);
  }

  async function saveTitleModel() {
    if (titleDraft === null) return;
    const next = await saveSettings({ ...currentSettings, titleModelRef: titleDraft }, '对话标题模型已更新');
    if (next) setTitleDraft(null);
  }

  async function deleteSelected() {
    if (!selected || selectedIndex !== pendingDelete) {
      setPendingDelete(selectedIndex);
      return;
    }
    if (currentSettings.providers.length <= 1) {
      notify({ variant: 'error', title: '至少保留一个 LLM 供应商' });
      return;
    }
    const providers = currentSettings.providers.filter((_, index) => index !== selectedIndex);
    const options = llmOptionsFromSettings({ ...currentSettings, providers });
    const defaultModelRef = options.some((option) => option.ref === currentSettings.defaultModelRef) ? currentSettings.defaultModelRef : options[0]?.ref ?? '';
    const titleModelRef = options.some((option) => option.ref === currentSettings.titleModelRef) ? currentSettings.titleModelRef : defaultModelRef;
    const next = await saveSettings({ providers, defaultModelRef, titleModelRef }, 'LLM 供应商已删除');
    if (!next) return;
    setSelectedIndex(Math.min(selectedIndex, next.providers.length - 1));
    setPendingDelete(null);
  }

  async function probeDraft() {
    if (!draft) return;
    setBusyAction('probe');
    try {
      const result = await controlApi.probeLlmProviderModels(draft);
      // 一次成功探测代表供应商当前的完整候选集合；已启用和手动选择的模型由 models 单独保留。
      setProviderDraft({ discoveredModels: result.models });
      notify({ variant: 'success', title: '模型列表拉取成功', description: `发现 ${result.models.length} 个候选模型` });
    } catch (err) {
      notify({ variant: 'error', title: '模型列表拉取失败', description: (err as Error).message });
    } finally {
      setBusyAction('');
    }
  }

  async function pingProvider(provider: LlmProviderSettings) {
    setBusyAction('ping');
    try {
      const result = await controlApi.pingLlmProvider(provider);
      notify({ variant: result.ok ? 'success' : 'error', title: `Ping ${result.ok ? '成功' : '失败'}`, description: `${result.latencyMs}ms · ${result.message}` });
    } catch (err) {
      notify({ variant: 'error', title: 'Ping 失败', description: (err as Error).message });
    } finally {
      setBusyAction('');
    }
  }

  function openChat(provider: LlmProviderSettings) {
    const models = providerCandidates(provider);
    setChatTest({ provider, model: provider.defaultModel || models[0] || '', input: '请用一句中文回复：模型可用。' });
  }

  async function runChatTest() {
    if (!chatTest) return;
    setBusyAction('chat');
    try {
      const result = await controlApi.testLlmProviderChat(chatTest.provider, chatTest.model, chatTest.input);
      setChatTest({ ...chatTest, result });
    } catch (err) {
      setChatTest({ ...chatTest, result: { ok: false, latencyMs: 0, model: chatTest.model, input: chatTest.input, output: (err as Error).message } });
    } finally {
      setBusyAction('');
    }
  }

  async function toggleModel(model: string, checked: boolean) {
    if (!draft) return;
    let resolvedCapability: LlmModelCapabilitySettings | null = null;
    if (checked && !draft.modelCapabilities.some((item) => item.model === model)) {
      setBusyAction(`catalog:${model}`);
      try {
        resolvedCapability = await resolveModelCapability(model);
      } catch (err) {
        resolvedCapability = fallbackCapability(model);
        notify({ variant: 'error', title: '模型资料读取失败，请手动填写能力', description: (err as Error).message });
      } finally {
        setBusyAction('');
      }
    }
    setProviderDraft((current) => {
      const models = new Set(current.models);
      const capabilities = new Map(current.modelCapabilities.map((item) => [item.model, item]));
      if (checked) {
        models.add(model);
        if (!capabilities.has(model) && resolvedCapability) capabilities.set(model, resolvedCapability);
      } else {
        models.delete(model);
        capabilities.delete(model);
      }
      return {
        models: [...models].sort(),
        modelCapabilities: [...capabilities.values()].filter((item) => models.has(item.model)).sort((a, b) => a.model.localeCompare(b.model)),
      };
    });
  }

  function updateModelCapability(model: string, patch: Partial<LlmModelCapabilitySettings>) {
    if (!draft) return;
    setProviderDraft((provider) => {
      const current = provider.modelCapabilities.find((item) => item.model === model)
        ?? fallbackCapability(model);
      const next: LlmModelCapabilitySettings = {
        ...current,
        ...patch,
        model,
        contextWindowSource: patch.contextWindow !== undefined ? 'manual' : current.contextWindowSource,
        compactionThresholdSource: patch.compactionThreshold !== undefined ? 'manual' : current.compactionThresholdSource,
        inputModalitiesSource: patch.inputModalities !== undefined ? 'manual' : current.inputModalitiesSource,
        references: current.references.flatMap((reference) => {
          const fields = reference.fields.filter((field) => (
            field !== 'contextWindow' || patch.contextWindow === undefined
          ) && (
            field !== 'inputModalities' || patch.inputModalities === undefined
          ));
          return fields.length ? [{ ...reference, fields }] : [];
        }),
      };
      return {
        modelCapabilities: provider.models.map((item) => item === model
          ? next
          : provider.modelCapabilities.find((capability) => capability.model === item)
            ?? fallbackCapability(item)),
      };
    });
  }

  function toggleModality(model: string, modality: LlmInputModality, checked: boolean) {
    if (!draft) return;
    const current = draft.modelCapabilities.find((item) => item.model === model) ?? fallbackCapability(model);
    const modalities = new Set<LlmInputModality>(current.inputModalities);
    if (checked) modalities.add(modality);
    else modalities.delete(modality);
    updateModelCapability(model, { inputModalities: [...modalities] });
  }

  async function refreshModelCapability(model: string) {
    if (!draft) return;
    setBusyAction(`catalog:${model}`);
    try {
      const capability = await resolveModelCapability(model, true);
      if (capability.contextWindow === null) {
        notify({ variant: 'error', title: '未在 models.dev 匹配到该模型，原配置保持不变' });
        return;
      }
      setProviderDraft((current) => ({
        modelCapabilities: current.modelCapabilities.map((item) => item.model === model ? capability : item),
      }));
      notify({ variant: 'success', title: '模型能力已更新' });
    } catch (err) {
      notify({ variant: 'error', title: '模型能力更新失败', description: (err as Error).message });
    } finally {
      setBusyAction('');
    }
  }

  async function addCustomModel() {
    if (!draft || !customModel.trim()) return;
    const model = customModel.trim();
    setBusyAction('catalog');
    try {
      const capability = await resolveModelCapability(model);
      setProviderDraft((current) => {
        const selectedCapabilities = new Map(current.modelCapabilities.map((item) => [item.model, item]));
        if (!selectedCapabilities.has(model)) selectedCapabilities.set(model, capability);
        return {
          discoveredModels: [...new Set([...current.discoveredModels, model])].sort(),
          models: [...new Set([...current.models, model])].sort(),
          modelCapabilities: [...selectedCapabilities.values()].sort((a, b) => a.model.localeCompare(b.model)),
        };
      });
      setCustomModel('');
    } catch (err) {
      setProviderDraft((current) => {
        const selectedCapabilities = new Map(current.modelCapabilities.map((item) => [item.model, item]));
        if (!selectedCapabilities.has(model)) selectedCapabilities.set(model, fallbackCapability(model));
        return {
          discoveredModels: [...new Set([...current.discoveredModels, model])].sort(),
          models: [...new Set([...current.models, model])].sort(),
          modelCapabilities: [...selectedCapabilities.values()].sort((a, b) => a.model.localeCompare(b.model)),
        };
      });
      setCustomModel('');
      notify({ variant: 'error', title: '模型资料读取失败，请手动填写能力', description: (err as Error).message });
    } finally {
      setBusyAction('');
    }
  }

  return (
    <PanelShell
      title="LLM 供应商"
      description="左侧选择供应商，默认查看摘要；只有编辑状态才加载完整配置表单"
      actions={<Button onClick={() => void beginCreate()} disabled={editing || editingModelSelection || Boolean(busyAction)}><Plus className="h-4 w-4" />新增供应商</Button>}
    >
      <div className="grid h-full min-h-0 gap-4 xl:grid-rows-[auto_minmax(0,1fr)]">
        <Card className="rounded-lg shadow-sm">
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0"><div className="text-xs text-muted-foreground">主 Agent 默认模型</div><div className="mt-1 truncate text-sm font-medium">{settings.defaultModelRef || '未设置'}</div></div>
            {defaultDraft === null ? (
              <Button variant="outline" size="sm" onClick={() => setDefaultDraft(settings.defaultModelRef)} disabled={editing || titleDraft !== null}><Pencil className="h-4 w-4" />更改</Button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                <div className="w-full max-w-md"><ModelSearchSelect value={defaultDraft} options={modelOptions} onChange={setDefaultDraft} /></div>
                <Button variant="outline" size="sm" onClick={() => setDefaultDraft(null)}><X className="h-4 w-4" />取消</Button>
                <Button size="sm" onClick={() => void saveDefaultModel()} disabled={busyAction === 'save'}><Save className="h-4 w-4" />保存</Button>
              </div>
            )}
          </CardContent>
          <CardContent className="flex items-center justify-between gap-4 border-t p-4">
            <div className="min-w-0"><div className="text-xs text-muted-foreground">对话标题模型</div><div className="mt-1 truncate text-sm font-medium">{settings.titleModelRef || '未设置'}</div></div>
            {titleDraft === null ? (
              <Button variant="outline" size="sm" onClick={() => setTitleDraft(settings.titleModelRef)} disabled={editing || defaultDraft !== null}><Pencil className="h-4 w-4" />更改</Button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                <div className="w-full max-w-md"><ModelSearchSelect value={titleDraft} options={modelOptions} onChange={setTitleDraft} /></div>
                <Button variant="outline" size="sm" onClick={() => setTitleDraft(null)}><X className="h-4 w-4" />取消</Button>
                <Button size="sm" onClick={() => void saveTitleModel()} disabled={busyAction === 'save'}><Save className="h-4 w-4" />保存</Button>
              </div>
            )}
          </CardContent>
        </Card>
        <EntityLayout
          list={settings.providers.map((provider, index) => (
            <button
              key={`${provider.id}-${index}`}
              type="button"
              disabled={editing || editingModelSelection}
              onClick={() => { setSelectedIndex(index); setPendingDelete(null); }}
              className={cn('grid gap-1 rounded-md border p-3 text-left transition-colors', index === selectedIndex && !editing ? 'border-primary bg-primary/5' : 'hover:bg-accent/60')}
            >
              <span className="truncate text-sm font-medium">{provider.label || provider.id}</span>
              <span className="truncate text-xs text-muted-foreground">{provider.id} · {provider.protocol}</span>
              <span className="text-xs text-muted-foreground">{provider.models.length} 个已启用模型</span>
            </button>
          ))}
        >
          {editing && draft ? (
            <Card className="rounded-lg shadow-sm">
              <CardHeader className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85">
                <div className="flex items-start justify-between gap-3">
                  <div><CardTitle>{editIndex! >= settings.providers.length ? '新增 LLM 供应商' : '编辑 LLM 供应商'}</CardTitle><CardDescription>保存前只修改当前草稿</CardDescription></div>
                  <div className="flex gap-2"><Button variant="outline" onClick={cancelEdit} disabled={Boolean(busyAction)}><X className="h-4 w-4" />取消</Button><Button onClick={() => void saveProvider()} disabled={Boolean(busyAction) || !draft.id.trim()}>{busyAction === 'save' ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}保存</Button></div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                {error && <div className="text-sm text-destructive">{error}</div>}
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="供应商 ID"><Input value={draft.id} onChange={(event) => setProviderDraft({ id: event.target.value })} /></Field>
                  <Field label="显示名称"><Input value={draft.label} onChange={(event) => setProviderDraft({ label: event.target.value })} /></Field>
                  <Field label="协议"><Select value={draft.protocol} onValueChange={(value) => setProviderDraft({ protocol: value as LlmProviderSettings['protocol'] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{PROTOCOL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
                  <Field label="Base URL"><Input value={draft.baseUrl} onChange={(event) => setProviderDraft({ baseUrl: event.target.value })} /></Field>
                  <Field label="API Key"><Input type="text" name="llm-provider-api-key" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" data-bwignore="true" className="[-webkit-text-security:disc]" value={draft.apiKey} onChange={(event) => setProviderDraft({ apiKey: event.target.value })} /></Field>
                  <Field label="默认模型"><Select value={draft.defaultModel || 'none'} onValueChange={(value) => setProviderDraft({ defaultModel: value === 'none' ? '' : value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">未设置</SelectItem>{draft.models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent></Select></Field>
                  <Field label="超时毫秒"><Input type="number" min={1000} value={draft.timeoutMs} onChange={(event) => setProviderDraft({ timeoutMs: Number(event.target.value) })} /></Field>
                  <Field label="重试次数"><Input type="number" min={0} value={draft.retries} onChange={(event) => setProviderDraft({ retries: Number(event.target.value) })} /></Field>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><div className="text-sm font-medium">候选模型</div><div className="text-xs text-muted-foreground">供应商接口只发现名称；选择模型时从 models.dev 读取能力并自动填写</div></div>
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setModelGroupsOpen(Object.fromEntries(groupedCandidates.map((group) => [`${draft.id}:${group.prefix}`, true])))}>展开全部</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setModelGroupsOpen(Object.fromEntries(groupedCandidates.map((group) => [`${draft.id}:${group.prefix}`, false])))}>收起全部</Button>
                    <Button variant="outline" size="sm" onClick={() => void probeDraft()} disabled={Boolean(busyAction)}>{busyAction === 'probe' ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}拉取模型列表</Button>
                  </div>
                </div>
                <ScrollArea className="rounded-md border" viewportClassName="max-h-80 !h-auto">
                  <div className="grid divide-y">
                    {!groupedCandidates.length && <div className="p-3 text-sm text-muted-foreground">暂无候选模型</div>}
                    {groupedCandidates.map((group) => {
                      const groupKey = `${draft.id}:${group.prefix}`;
                      const open = modelGroupsOpen[groupKey] ?? true;
                      const selectedCount = group.models.filter((model) => draft.models.includes(model)).length;
                      return (
                        <Collapsible key={groupKey} open={open} onOpenChange={(nextOpen) => setModelGroupsOpen((current) => ({ ...current, [groupKey]: nextOpen }))}>
                          <CollapsibleTrigger asChild>
                            <button type="button" className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2 text-left hover:bg-muted/60">
                              <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
                              <span className="text-sm font-medium">{group.prefix}</span>
                              <Badge variant="outline" className="ml-auto">{selectedCount} / {group.models.length}</Badge>
                            </button>
                          </CollapsibleTrigger>
                          <CollapsibleContent className="grid md:grid-cols-2">
                            {group.models.map((model) => <label key={model} className="flex cursor-pointer items-center gap-2 border-t p-3 hover:bg-accent/60"><Checkbox checked={draft.models.includes(model)} disabled={Boolean(busyAction)} onCheckedChange={(checked) => void toggleModel(model, checked === true)} /><span className="min-w-0 truncate text-sm">{model}</span></label>)}
                          </CollapsibleContent>
                        </Collapsible>
                      );
                    })}
                  </div>
                </ScrollArea>
                <Field label="添加自定义模型"><div className="flex gap-2"><Input value={customModel} onChange={(event) => setCustomModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addCustomModel(); } }} /><Button variant="outline" onClick={() => void addCustomModel()} disabled={Boolean(busyAction)}>{busyAction === 'catalog' ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />}添加并选择</Button></div></Field>
                <div className="grid gap-3">
                  <div><div className="text-sm font-medium">已选择模型</div><div className="text-xs text-muted-foreground">匹配 models.dev 时自动填写；未匹配时必须人工填写模型能力</div></div>
                  {!draft.models.length && <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">尚未选择模型</div>}
                  {draft.models.map((model) => {
                    const capability = draft.modelCapabilities.find((item) => item.model === model)
                      ?? fallbackCapability(model);
                    const incomplete = capability.contextWindow === null
                      || capability.compactionThreshold === null
                      || capability.inputModalities.length === 0
                      || (draft.protocol === 'anthropic-messages' && capability.maxOutputTokens === null);
                    return (
                      <Card key={model} className="rounded-md shadow-none">
                        <CardContent className="grid gap-3 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2"><div className="break-all text-sm font-medium">{model}</div><div className="flex items-center gap-2">{model === draft.defaultModel && <Badge>默认模型</Badge>}<Button type="button" variant="outline" size="sm" onClick={() => void refreshModelCapability(model)} disabled={Boolean(busyAction)}>{busyAction === `catalog:${model}` ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}刷新模型能力</Button></div></div>
                          <div className="grid gap-3 xl:grid-cols-3">
                            <Field label="上下文长度（tokens）">
                              <div className="flex gap-2">
                                <Input className="min-w-0 flex-1" type="number" min={1} max={10000000} value={capability.contextWindow ?? ''} placeholder="必须填写" onChange={(event) => updateModelCapability(model, { contextWindow: event.target.value === '' ? null : Number(event.target.value) })} />
                                <Select value={contextWindowPresetValue(capability.contextWindow)} onValueChange={(value) => { if (value !== 'custom') updateModelCapability(model, { contextWindow: Number(value) }); }}>
                                  <SelectTrigger className="w-44 shrink-0"><SelectValue placeholder="常用长度" /></SelectTrigger>
                                  <SelectContent>
                                    {CONTEXT_WINDOW_PRESETS.map((preset) => <SelectItem key={preset.value} value={String(preset.value)}>{preset.label}</SelectItem>)}
                                    <SelectItem value="custom">自定义</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </Field>
                            <Field label="压缩阈值（tokens）">
                              <Input type="number" min={1} max={capability.contextWindow ?? 10000000} value={capability.compactionThreshold ?? ''} placeholder="必须填写" onChange={(event) => updateModelCapability(model, { compactionThreshold: event.target.value === '' ? null : Number(event.target.value) })} />
                            </Field>
                            <Field label="多模态输入">
                              <div className="flex min-h-10 flex-wrap items-center gap-4 rounded-md border px-3 py-2">
                                {INPUT_MODALITY_OPTIONS.map((option) => <label key={option.value} className="flex items-center gap-2 text-sm"><Checkbox checked={capability.inputModalities.includes(option.value)} onCheckedChange={(checked) => toggleModality(model, option.value, checked === true)} />{option.label}</label>)}
                              </div>
                            </Field>
                            {draft.protocol === 'anthropic-messages' && <Field label="最大输出长度（tokens）"><Input type="number" min={1} max={10000000} value={capability.maxOutputTokens ?? ''} placeholder="Anthropic 协议必填" onChange={(event) => updateModelCapability(model, { maxOutputTokens: event.target.value === '' ? null : Number(event.target.value) })} /></Field>}
                          </div>
                          {(incomplete || capability.references.length > 0) && <div className="grid gap-2 rounded-md bg-muted/30 p-3 text-xs text-muted-foreground">
                            {incomplete && <div className="text-destructive">该模型的能力配置尚未完成，保存会被拒绝。</div>}
                            {capability.references.map((reference) => <a key={`${reference.url}:${reference.fields.join(',')}`} className="w-fit underline underline-offset-4" href={reference.url} target="_blank" rel="noreferrer">{reference.title} · 检查于 {reference.checkedAt}</a>)}
                          </div>}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ) : selected ? (
            <Card className="rounded-lg shadow-sm">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div><CardTitle>{selected.label || selected.id}</CardTitle><CardDescription>{selected.id} · {selected.protocol}</CardDescription></div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => void pingProvider(selected)} disabled={Boolean(busyAction)}><Wifi className="h-4 w-4" />Ping</Button>
                    <Button variant="outline" size="sm" onClick={() => openChat(selected)} disabled={Boolean(busyAction) || providerCandidates(selected).length === 0}><MessageSquare className="h-4 w-4" />模拟对话</Button>
                    <Button variant="outline" size="sm" onClick={beginEdit}><Pencil className="h-4 w-4" />编辑</Button>
                    <Button variant={pendingDelete === selectedIndex ? 'destructive' : 'outline'} size="sm" onClick={() => void deleteSelected()} disabled={Boolean(busyAction)}><Trash2 className="h-4 w-4" />{pendingDelete === selectedIndex ? '确认删除' : '删除'}</Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <SummaryRow label="协议" value={selected.protocol} />
                  <SummaryRow label="Base URL" value={selected.baseUrl} />
                  <SummaryRow label="API Key" value={selected.apiKey ? '已配置' : '未配置'} />
                  <SummaryRow label="默认模型" value={selected.defaultModel || '未设置'} />
                  <SummaryRow label="超时 / 重试" value={`${selected.timeoutMs} ms / ${selected.retries} 次`} />
                </div>
                <div className="grid gap-2">
                  <div className="text-sm font-medium">已启用模型</div>
                  {!selected.models.length && <span className="text-sm text-muted-foreground">未启用模型</span>}
                  {selected.models.map((model) => {
                    const capability = selected.modelCapabilities.find((item) => item.model === model) ?? fallbackCapability(model);
                    return <div key={model} className="flex flex-wrap items-center gap-2 rounded-md border p-3"><span className="mr-auto break-all text-sm font-medium">{model}</span><Badge variant="outline">{capability.contextWindow === null ? '待填写上下文' : `${capability.contextWindow.toLocaleString()} tokens`}</Badge><Badge variant="outline">{capability.compactionThreshold === null ? '待填写压缩阈值' : `压缩 ${capability.compactionThreshold.toLocaleString()}`}</Badge>{selected.protocol === 'anthropic-messages' && <Badge variant="outline">{capability.maxOutputTokens === null ? '待填写最大输出' : `最大输出 ${capability.maxOutputTokens.toLocaleString()}`}</Badge>}{capability.inputModalities.map((modality) => <Badge key={modality} variant="secondary">{modality}</Badge>)}</div>;
                  })}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </EntityLayout>
      </div>

      <Dialog open={Boolean(chatTest)} onOpenChange={(open) => !open && setChatTest(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>模拟对话</DialogTitle><DialogDescription>使用当前已保存的供应商配置发起一次真实模型调用。</DialogDescription></DialogHeader>
          {chatTest && <div className="grid gap-4"><Field label="测试模型"><Select value={chatTest.model} onValueChange={(model) => setChatTest({ ...chatTest, model })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{providerCandidates(chatTest.provider).map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent></Select></Field><Field label="输入内容"><Textarea rows={6} value={chatTest.input} onChange={(event) => setChatTest({ ...chatTest, input: event.target.value })} /></Field>{chatTest.result && <div className={cn('rounded-md border p-3 text-sm', chatTest.result.ok ? 'border-emerald-500/40' : 'border-destructive/50')}><div className="font-medium">{chatTest.result.ok ? '调用成功' : '调用失败'} · {chatTest.result.latencyMs}ms</div><div className="mt-2 whitespace-pre-wrap text-muted-foreground">{chatTest.result.output}</div></div>}</div>}
          <DialogFooter><Button variant="outline" onClick={() => setChatTest(null)}>关闭</Button><Button onClick={() => void runChatTest()} disabled={!chatTest?.model || !chatTest?.input.trim() || busyAction === 'chat'}>{busyAction === 'chat' ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" />}发送测试</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}
