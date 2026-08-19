import { useEffect, useMemo, useState } from 'react';
import { Bot, Image, Pencil, Plus, Save, Settings2, Trash2, Video, X } from 'lucide-react';
import type {
  RuntimeCapabilitiesSettings,
  RuntimeImageCapabilityModel,
  RuntimeLlmCapabilityModel,
  RuntimeVideoCapabilityModel,
} from '@runforge/contracts';
import type { SettingsControlApi } from '../../controlApi';
import { Field } from '../../components/SettingsView';
import { llmOptionsFromSettings, ModelSearchSelect } from '../../components/ModelSearchSelect';
import { useNotifications } from '../../components/GlobalNotifications';
import { EntityLayout, PanelShell, SummaryRow } from './ProviderSettingsPanels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

type RuntimeSection = 'overview' | 'llm' | 'image' | 'video';

function ListButton({ active, children, disabled = false, onClick }: { active: boolean; children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={cn('grid gap-1 rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60', active ? 'border-primary bg-primary/5' : 'hover:bg-accent/60')}>{children}</button>;
}

function SectionButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <Button variant={active ? 'secondary' : 'ghost'} size="sm" className="w-full justify-start" onClick={onClick}>{icon}{label}</Button>;
}

function nextDefaultId<T extends { id: string }>(models: T[], current: string): string {
  return models.some((model) => model.id === current) ? current : models[0]?.id ?? '';
}

function LlmModelsSection({
  capability,
  llmOptions,
  onSave,
}: {
  capability: RuntimeCapabilitiesSettings['llm'];
  llmOptions: ReturnType<typeof llmOptionsFromSettings>;
  onSave: (next: RuntimeCapabilitiesSettings['llm'], title: string) => Promise<boolean>;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<RuntimeLlmCapabilityModel | null>(null);
  const [defaultDraft, setDefaultDraft] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const selected = capability.models[selectedIndex] ?? null;

  async function saveModel() {
    if (!draft || editIndex === null) return;
    const models = [...capability.models];
    if (editIndex >= models.length) models.push(draft); else models[editIndex] = draft;
    if (await onSave({ ...capability, models, defaultModelId: nextDefaultId(models, capability.defaultModelId) }, '运行时 LLM 模型已保存')) {
      setSelectedIndex(Math.min(editIndex, models.length - 1)); setEditIndex(null); setDraft(null);
    }
  }

  async function deleteModel() {
    if (!selected || pendingDelete !== selectedIndex) { setPendingDelete(selectedIndex); return; }
    const models = capability.models.filter((_, index) => index !== selectedIndex);
    if (await onSave({ ...capability, models, defaultModelId: nextDefaultId(models, capability.defaultModelId) }, '运行时 LLM 模型已删除')) {
      setSelectedIndex(Math.min(selectedIndex, Math.max(0, models.length - 1))); setPendingDelete(null);
    }
  }

  return (
    <EntityLayout list={<><Button size="sm" disabled={editIndex !== null} onClick={() => { const index = capability.models.length; const modelRef = llmOptions[0]?.ref ?? ''; setEditIndex(index); setDraft({ id: `llm-${index + 1}`, label: modelRef || `LLM ${index + 1}`, modelRef }); }}><Plus className="h-4 w-4" />新增模型</Button>{capability.models.map((model, index) => <ListButton key={`${model.id}-${index}`} active={index === selectedIndex && editIndex === null} disabled={editIndex !== null} onClick={() => { if (editIndex === null) { setSelectedIndex(index); setPendingDelete(null); } }}><span className="truncate text-sm font-medium">{model.label || model.id}</span><span className="truncate text-xs text-muted-foreground">{model.id}</span></ListButton>)}</>}>
      <DefaultSelector label="默认运行时 LLM 模型" value={capability.defaultModelId} draft={defaultDraft} options={capability.models} onEdit={() => setDefaultDraft(capability.defaultModelId)} onCancel={() => setDefaultDraft(null)} onChange={setDefaultDraft} onSave={async () => { if (defaultDraft !== null && await onSave({ ...capability, defaultModelId: defaultDraft }, '默认运行时 LLM 模型已更新')) setDefaultDraft(null); }} />
      <div className="mt-4">
        {editIndex !== null && draft ? <Card><CardHeader><EditorHeader title={editIndex >= capability.models.length ? '新增 LLM 模型' : '编辑 LLM 模型'} disabled={!draft.id.trim() || !draft.modelRef.trim()} onCancel={() => { setEditIndex(null); setDraft(null); }} onSave={() => void saveModel()} /></CardHeader><CardContent className="grid gap-3 md:grid-cols-2"><Field label="模型 ID"><Input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field><Field label="显示名称"><Input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field><div className="md:col-span-2"><Field label="后端模型"><ModelSearchSelect value={draft.modelRef} options={llmOptions} onChange={(modelRef) => setDraft({ ...draft, modelRef })} /></Field></div></CardContent></Card> : selected ? <ReadOnlyModel title={selected.label || selected.id} subtitle={selected.id} actions={<><Button variant="outline" size="sm" onClick={() => { setEditIndex(selectedIndex); setDraft({ ...selected }); }}><Pencil className="h-4 w-4" />编辑</Button><DeleteButton confirming={pendingDelete === selectedIndex} onClick={() => void deleteModel()} /></>} rows={<><SummaryRow label="运行时模型 ID" value={selected.id} /><SummaryRow label="后端 modelRef" value={selected.modelRef} /></>} /> : <Empty />}
      </div>
    </EntityLayout>
  );
}

function ImageModelsSection({ capability, onSave }: { capability: RuntimeCapabilitiesSettings['image']; onSave: (next: RuntimeCapabilitiesSettings['image'], title: string) => Promise<boolean> }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<RuntimeImageCapabilityModel | null>(null);
  const [defaultDraft, setDefaultDraft] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const selected = capability.models[selectedIndex] ?? null;

  async function saveModel() {
    if (!draft || editIndex === null) return;
    const models = [...capability.models];
    if (editIndex >= models.length) models.push(draft); else models[editIndex] = draft;
    if (await onSave({ ...capability, models, defaultModelId: nextDefaultId(models, capability.defaultModelId) }, '图片模型已保存')) { setSelectedIndex(Math.min(editIndex, models.length - 1)); setEditIndex(null); setDraft(null); }
  }
  async function deleteModel() {
    if (!selected || pendingDelete !== selectedIndex) { setPendingDelete(selectedIndex); return; }
    const models = capability.models.filter((_, index) => index !== selectedIndex);
    if (await onSave({ ...capability, models, defaultModelId: nextDefaultId(models, capability.defaultModelId) }, '图片模型已删除')) { setSelectedIndex(Math.min(selectedIndex, Math.max(0, models.length - 1))); setPendingDelete(null); }
  }

  return (
    <EntityLayout list={<><Button size="sm" disabled={editIndex !== null} onClick={() => { const index = capability.models.length; setEditIndex(index); setDraft({ id: `image-${index + 1}`, label: `图片模型 ${index + 1}`, provider: 'packy-gpt-image-2', baseUrl: 'https://cf.api.fan', apiKey: '', model: 'gpt-image-2', timeoutMs: 180_000 }); }}><Plus className="h-4 w-4" />新增模型</Button>{capability.models.map((model, index) => <ListButton key={`${model.id}-${index}`} active={index === selectedIndex && editIndex === null} disabled={editIndex !== null} onClick={() => { if (editIndex === null) { setSelectedIndex(index); setPendingDelete(null); } }}><span className="truncate text-sm font-medium">{model.label || model.id}</span><span className="truncate text-xs text-muted-foreground">{model.model}</span></ListButton>)}</>}>
      <DefaultSelector label="默认图片模型" value={capability.defaultModelId} draft={defaultDraft} options={capability.models} onEdit={() => setDefaultDraft(capability.defaultModelId)} onCancel={() => setDefaultDraft(null)} onChange={setDefaultDraft} onSave={async () => { if (defaultDraft !== null && await onSave({ ...capability, defaultModelId: defaultDraft }, '默认图片模型已更新')) setDefaultDraft(null); }} />
      <div className="mt-4">{editIndex !== null && draft ? <Card><CardHeader><EditorHeader title={editIndex >= capability.models.length ? '新增图片模型' : '编辑图片模型'} disabled={!draft.id.trim() || !draft.model.trim()} onCancel={() => { setEditIndex(null); setDraft(null); }} onSave={() => void saveModel()} /></CardHeader><CardContent className="grid gap-3 md:grid-cols-2"><Field label="模型 ID"><Input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field><Field label="显示名称"><Input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field><Field label="上游模型"><Input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></Field><Field label="Base URL"><Input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></Field><Field label="API Key"><Input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></Field><Field label="超时毫秒"><Input type="number" min={1000} value={draft.timeoutMs} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })} /></Field></CardContent></Card> : selected ? <ReadOnlyModel title={selected.label || selected.id} subtitle={selected.id} actions={<><Button variant="outline" size="sm" onClick={() => { setEditIndex(selectedIndex); setDraft({ ...selected }); }}><Pencil className="h-4 w-4" />编辑</Button><DeleteButton confirming={pendingDelete === selectedIndex} onClick={() => void deleteModel()} /></>} rows={<><SummaryRow label="上游模型" value={selected.model} /><SummaryRow label="供应商" value={selected.provider} /><SummaryRow label="Base URL" value={selected.baseUrl} /><SummaryRow label="API Key" value={selected.apiKey ? '已配置' : '未配置'} /><SummaryRow label="超时" value={`${selected.timeoutMs} ms`} /></>} /> : <Empty />}</div>
    </EntityLayout>
  );
}

function VideoModelsSection({ capability, onSave }: { capability: RuntimeCapabilitiesSettings['video']; onSave: (next: RuntimeCapabilitiesSettings['video'], title: string) => Promise<boolean> }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<RuntimeVideoCapabilityModel | null>(null);
  const [defaultDraft, setDefaultDraft] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const selected = capability.models[selectedIndex] ?? null;
  async function saveModel() { if (!draft || editIndex === null) return; const models = [...capability.models]; if (editIndex >= models.length) models.push(draft); else models[editIndex] = draft; if (await onSave({ ...capability, models, defaultModelId: nextDefaultId(models, capability.defaultModelId) }, '视频模型已保存')) { setSelectedIndex(Math.min(editIndex, models.length - 1)); setEditIndex(null); setDraft(null); } }
  async function deleteModel() { if (!selected || pendingDelete !== selectedIndex) { setPendingDelete(selectedIndex); return; } const models = capability.models.filter((_, index) => index !== selectedIndex); if (await onSave({ ...capability, models, defaultModelId: nextDefaultId(models, capability.defaultModelId) }, '视频模型已删除')) { setSelectedIndex(Math.min(selectedIndex, Math.max(0, models.length - 1))); setPendingDelete(null); } }
  return (
    <EntityLayout list={<><Button size="sm" disabled={editIndex !== null} onClick={() => { const index = capability.models.length; setEditIndex(index); setDraft({ id: `video-${index + 1}`, label: `视频模型 ${index + 1}`, provider: '', model: '' }); }}><Plus className="h-4 w-4" />新增模型</Button>{capability.models.map((model, index) => <ListButton key={`${model.id}-${index}`} active={index === selectedIndex && editIndex === null} disabled={editIndex !== null} onClick={() => { if (editIndex === null) { setSelectedIndex(index); setPendingDelete(null); } }}><span className="truncate text-sm font-medium">{model.label || model.id}</span><span className="truncate text-xs text-muted-foreground">{model.provider}:{model.model}</span></ListButton>)}</>}>
      <DefaultSelector label="默认视频模型" value={capability.defaultModelId} draft={defaultDraft} options={capability.models} onEdit={() => setDefaultDraft(capability.defaultModelId)} onCancel={() => setDefaultDraft(null)} onChange={setDefaultDraft} onSave={async () => { if (defaultDraft !== null && await onSave({ ...capability, defaultModelId: defaultDraft }, '默认视频模型已更新')) setDefaultDraft(null); }} />
      <div className="mt-4">{editIndex !== null && draft ? <Card><CardHeader><EditorHeader title={editIndex >= capability.models.length ? '新增视频模型' : '编辑视频模型'} disabled={!draft.id.trim() || !draft.provider.trim() || !draft.model.trim()} onCancel={() => { setEditIndex(null); setDraft(null); }} onSave={() => void saveModel()} /></CardHeader><CardContent className="grid gap-3 md:grid-cols-2"><Field label="模型 ID"><Input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></Field><Field label="显示名称"><Input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field><Field label="供应商"><Input value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} /></Field><Field label="上游模型"><Input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></Field></CardContent></Card> : selected ? <ReadOnlyModel title={selected.label || selected.id} subtitle={selected.id} actions={<><Button variant="outline" size="sm" onClick={() => { setEditIndex(selectedIndex); setDraft({ ...selected }); }}><Pencil className="h-4 w-4" />编辑</Button><DeleteButton confirming={pendingDelete === selectedIndex} onClick={() => void deleteModel()} /></>} rows={<><SummaryRow label="供应商" value={selected.provider} /><SummaryRow label="上游模型" value={selected.model} /></>} /> : <Empty />}</div>
    </EntityLayout>
  );
}

function DefaultSelector<T extends { id: string; label: string }>({ label, value, draft, options, onEdit, onCancel, onChange, onSave }: { label: string; value: string; draft: string | null; options: T[]; onEdit: () => void; onCancel: () => void; onChange: (value: string) => void; onSave: () => void }) {
  return <Card><CardContent className="flex items-center justify-between gap-3 p-4"><div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{options.find((model) => model.id === value)?.label || value || '未设置'}</div></div>{draft === null ? <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="h-4 w-4" />更改</Button> : <div className="flex flex-1 justify-end gap-2"><Select value={draft || 'none'} onValueChange={(next) => onChange(next === 'none' ? '' : next)}><SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">无默认模型</SelectItem>{options.map((model) => <SelectItem key={model.id} value={model.id}>{model.label || model.id}</SelectItem>)}</SelectContent></Select><Button variant="outline" size="sm" onClick={onCancel}><X className="h-4 w-4" />取消</Button><Button size="sm" onClick={onSave}><Save className="h-4 w-4" />保存</Button></div>}</CardContent></Card>;
}

function EditorHeader({ title, disabled = false, onCancel, onSave }: { title: string; disabled?: boolean; onCancel: () => void; onSave: () => void }) { return <div className="flex items-start justify-between gap-3"><div><CardTitle>{title}</CardTitle><CardDescription>保存前只修改当前模型草稿</CardDescription></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={onCancel}><X className="h-4 w-4" />取消</Button><Button size="sm" onClick={onSave} disabled={disabled}><Save className="h-4 w-4" />保存</Button></div></div>; }
function DeleteButton({ confirming, onClick }: { confirming: boolean; onClick: () => void }) { return <Button variant={confirming ? 'destructive' : 'outline'} size="sm" onClick={onClick}><Trash2 className="h-4 w-4" />{confirming ? '确认删除' : '删除'}</Button>; }
function ReadOnlyModel({ title, subtitle, actions, rows }: { title: string; subtitle: string; actions: React.ReactNode; rows: React.ReactNode }) { return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>{title}</CardTitle><CardDescription>{subtitle}</CardDescription></div><div className="flex gap-2">{actions}</div></div></CardHeader><CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows}</CardContent></Card>; }
function Empty() { return <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">选择或新建一个模型</div>; }

export function RuntimeCapabilitySettingsPanel({ controlApi }: { controlApi: SettingsControlApi }) {
  const { notify } = useNotifications();
  const [settings, setSettings] = useState<RuntimeCapabilitiesSettings | null>(null);
  const [llmSettings, setLlmSettings] = useState<Awaited<ReturnType<SettingsControlApi['getLlmSettings']>> | null>(null);
  const [section, setSection] = useState<RuntimeSection>('overview');
  const [overviewDraft, setOverviewDraft] = useState<RuntimeCapabilitiesSettings | null>(null);
  const [busy, setBusy] = useState(false);

  // 能力类型是二级菜单，具体模型继续遵循“列表 → 详情 → 编辑草稿”的统一状态机。
  useEffect(() => {
    let canceled = false;
    Promise.all([controlApi.getRuntimeCapabilitiesSettings(), controlApi.getLlmSettings()]).then(([runtime, llm]) => { if (!canceled) { setSettings(runtime); setOverviewDraft(runtime); setLlmSettings(llm); } }).catch((err) => notify({ variant: 'error', title: '运行时能力加载失败', description: (err as Error).message }));
    return () => { canceled = true; };
  }, [controlApi, notify]);

  const llmOptions = useMemo(() => llmSettings ? llmOptionsFromSettings(llmSettings) : [], [llmSettings]);
  if (!settings || !overviewDraft) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在读取运行时能力...</div>;

  async function persist(next: RuntimeCapabilitiesSettings, title: string): Promise<boolean> {
    setBusy(true);
    try { const saved = await controlApi.updateRuntimeCapabilitiesSettings(next); setSettings(saved); setOverviewDraft(saved); notify({ variant: 'success', title }); return true; }
    catch (err) { notify({ variant: 'error', title: '运行时能力保存失败', description: (err as Error).message }); return false; }
    finally { setBusy(false); }
  }

  return <PanelShell title="运行时能力" description="按能力浏览模型列表，只有当前编辑项显示表单" actions={busy ? <Spinner className="h-5 w-5" /> : null}>
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <Card className="h-full"><CardContent className="grid content-start gap-1 p-3"><SectionButton active={section === 'overview'} icon={<Settings2 className="h-4 w-4" />} label="能力开关" onClick={() => setSection('overview')} /><SectionButton active={section === 'llm'} icon={<Bot className="h-4 w-4" />} label="LLM 模型" onClick={() => setSection('llm')} /><SectionButton active={section === 'image'} icon={<Image className="h-4 w-4" />} label="图片模型" onClick={() => setSection('image')} /><SectionButton active={section === 'video'} icon={<Video className="h-4 w-4" />} label="视频模型" onClick={() => setSection('video')} /></CardContent></Card>
      <div className="h-full min-h-0 overflow-y-auto pr-1">
        {section === 'overview' && <Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>能力开关</CardTitle><CardDescription>开关影响新 run 和运行时凭证接口</CardDescription></div><Button onClick={() => void persist(overviewDraft, '能力开关已保存')} disabled={busy}><Save className="h-4 w-4" />保存</Button></div></CardHeader><CardContent className="grid gap-3">{([['llm', 'LLM 代理凭证'], ['image', '图片生成凭证'], ['video', '视频生成凭证']] as const).map(([kind, label]) => <div key={kind} className="flex items-center justify-between rounded-md border p-3"><div className="text-sm font-medium">{label}</div><Switch checked={overviewDraft[kind].enabled} onCheckedChange={(enabled) => setOverviewDraft({ ...overviewDraft, [kind]: { ...overviewDraft[kind], enabled } })} /></div>)}</CardContent></Card>}
        {section === 'llm' && <LlmModelsSection capability={settings.llm} llmOptions={llmOptions} onSave={(llm, title) => persist({ ...settings, llm }, title)} />}
        {section === 'image' && <ImageModelsSection capability={settings.image} onSave={(image, title) => persist({ ...settings, image }, title)} />}
        {section === 'video' && <VideoModelsSection capability={settings.video} onSave={(video, title) => persist({ ...settings, video }, title)} />}
      </div>
    </div>
  </PanelShell>;
}
