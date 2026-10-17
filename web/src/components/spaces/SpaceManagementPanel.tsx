import { useEffect, useMemo, useState } from 'react';
import type { CreateSpaceInput, SpaceOptions, SpaceSummary, TenantUserSummary, UpdateSpaceInput, UsageAggregateResponse } from '@runforge/contracts';
import { FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { SpaceControlApi } from '@/spaceControlApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ExternalCallersPanel } from './ExternalCallersPanel';
import { SpaceEditorDialog } from './SpaceEditorDialog';
import { SpaceTaskUsagePanel } from '@/components/usage/SpaceTaskUsagePanel';
import type { UsageQuery } from '@/usageApi';

function userLabel(users: TenantUserSummary[], id: string | null): string {
  if (!id) return '无';
  const user = users.find((item) => item.id === id);
  return user ? `${user.email} · ${user.role}` : id;
}

export function SpaceManagementPanel({
  api,
  onManagePrompt,
  loadUsage,
}: {
  api: SpaceControlApi;
  loadUsage: (query: UsageQuery) => Promise<UsageAggregateResponse>;
  onManagePrompt: (spaceId: string) => void;
}) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [users, setUsers] = useState<TenantUserSummary[]>([]);
  const [options, setOptions] = useState<SpaceOptions | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSpace, setEditingSpace] = useState<SpaceSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SpaceSummary | null>(null);
  const [replacementDefaultSpaceId, setReplacementDefaultSpaceId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [savingModel, setSavingModel] = useState(false);

  const selected = useMemo(
    () => spaces.find((space) => space.id === selectedId) ?? spaces[0] ?? null,
    [selectedId, spaces],
  );
  const allowedModels = (options?.models ?? []).filter((model) => selected?.config.model.allowedModelRefs.includes(model.ref));

  async function refresh(preferredId = selectedId) {
    setLoading(true);
    try {
      const [spaceResult, optionResult, userResult] = await Promise.all([
        api.listSpaces(),
        api.getOptions(),
        api.listUsers(),
      ]);
      setSpaces(spaceResult.spaces);
      setOptions(optionResult);
      setUsers(userResult.users);
      setSelectedId(spaceResult.spaces.some((space) => space.id === preferredId)
        ? preferredId
        : spaceResult.spaces[0]?.id ?? null);
      setMessage('');
    } catch (error) {
      setMessage(`读取空间配置失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedId(null);
    void refresh(null);
  }, [api]);

  function openCreate() {
    setEditingSpace(null);
    setEditorError('');
    setEditorOpen(true);
  }

  function openEdit(space: SpaceSummary) {
    setEditingSpace(space);
    setEditorError('');
    setEditorOpen(true);
  }

  async function saveSpace(input: CreateSpaceInput | UpdateSpaceInput) {
    setSaving(true);
    setEditorError('');
    try {
      const saved = editingSpace
        ? await api.updateSpace(editingSpace.id, input as UpdateSpaceInput)
        : await api.createSpace(input as CreateSpaceInput);
      setEditorOpen(false);
      setEditingSpace(null);
      await refresh(saved.id);
    } catch (error) {
      setEditorError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function changeDefaultModel(defaultModelRef: string) {
    if (!selected) return;
    setSavingModel(true);
    setMessage('');
    try {
      // 只提交默认模型字段，由服务端合并当前配置，保留其他管理员设置的能力和提示词。
      const saved = await api.updateSpace(selected.id, { config: { model: { defaultModelRef } } });
      setSpaces((current) => current.map((space) => space.id === saved.id ? saved : space));
      setMessage('默认模型已保存，将用于后续新任务。');
    } catch (error) {
      setMessage(`切换默认模型失败：${(error as Error).message}`);
    } finally {
      setSavingModel(false);
    }
  }

  function openDelete(space: SpaceSummary) {
    setDeleteTarget(space);
    setReplacementDefaultSpaceId(
      space.isDefault
        ? spaces.find((candidate) => candidate.id !== space.id && candidate.mode === 'web')?.id ?? ''
        : '',
    );
  }

  async function deleteSpace() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteSpace(deleteTarget.id, deleteTarget.isDefault
        ? { replacementDefaultSpaceId }
        : {});
      const preferredId = deleteTarget.isDefault ? replacementDefaultSpaceId : null;
      setDeleteTarget(null);
      await refresh(preferredId);
      setMessage('空间及其数据库记录已永久删除，关联文件清理已经执行。');
    } catch (error) {
      setMessage(`删除空间失败：${(error as Error).message}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
      <CardHeader className="shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">空间</CardTitle>
            <CardDescription>空间属于租户；租户管理员和系统管理员可管理，普通用户严格按可见名单访问。</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || savingModel}>
              <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />刷新
            </Button>
            <Button size="sm" onClick={openCreate}><Plus className="size-4" />新建空间</Button>
          </div>
        </div>
        {message && <div className={cn('text-sm text-muted-foreground', message.includes('失败') && 'text-destructive')}>{message}</div>}
      </CardHeader>

      <CardContent className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden">
        <div className="scrollbar-thin max-h-48 min-h-0 overflow-y-auto rounded-md border p-2 lg:max-h-none">
          {spaces.map((space) => (
            <button
              type="button"
              key={space.id}
              onClick={() => setSelectedId(space.id)}
              className={cn(
                'mb-1 grid w-full gap-1 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/60',
                selected?.id === space.id && 'bg-accent ring-1 ring-border',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{space.name}</span>
                {space.isDefault && <Badge variant="outline">default</Badge>}
                <Badge variant={space.mode === 'external' ? 'secondary' : 'outline'}>{space.mode}</Badge>
              </span>
              <span className="truncate text-xs text-muted-foreground">{space.id} · 配置 v{space.configVersion}</span>
            </button>
          ))}
          {!spaces.length && !loading && <div className="p-4 text-sm text-muted-foreground">当前租户没有空间。</div>}
        </div>

        <div className="scrollbar-thin min-h-[28rem] min-w-0 overflow-y-auto pr-1 lg:min-h-0">
          {selected ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                  <h2 className="truncate text-lg font-semibold">{selected.name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{selected.id} · 创建 {new Date(selected.createdAt).toLocaleString()} · 更新 {new Date(selected.updatedAt).toLocaleString()}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => onManagePrompt(selected.id)}>
                  <FileText className="size-4" />提示词
                </Button>
                <Button variant="outline" size="sm" disabled={savingModel} onClick={() => openEdit(selected)}><Pencil className="size-4" />编辑</Button>
                <Button variant="destructive" size="sm" disabled={savingModel} onClick={() => openDelete(selected)}>
                  <Trash2 className="size-4" />永久删除
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">模式</div><div className="mt-1 text-sm font-medium">{selected.mode === 'external' ? '外部运行 · Web 只读' : 'Web 对话'}</div></div>
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">执行用户</div><div className="mt-1 truncate text-sm font-medium" title={selected.executionUserId ?? ''}>{userLabel(users, selected.executionUserId)}</div></div>
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">可见 member</div><div className="mt-1 text-sm font-medium">{selected.visibleUserIds.length} 人</div></div>
              </div>

              <div className="grid gap-2 rounded-md border p-3">
                <div className="text-sm font-medium">空间默认模型</div>
                <Select
                  value={allowedModels.some((model) => model.ref === selected.config.model.defaultModelRef) ? selected.config.model.defaultModelRef! : ''}
                  onValueChange={(modelRef) => void changeDefaultModel(modelRef)}
                  disabled={savingModel || loading || !allowedModels.length}
                >
                  <SelectTrigger aria-label="空间默认模型"><SelectValue placeholder={selected.config.model.defaultModelRef ?? '选择默认模型'} /></SelectTrigger>
                  <SelectContent>
                    {allowedModels.map((model) => <SelectItem key={model.ref} value={model.ref}>{model.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">选择后直接保存，仅影响后续新任务；允许使用的模型在编辑中设置。</p>
              </div>

              <div className="grid gap-3 rounded-md border p-3">
                <div className="text-sm font-medium">业务插件</div>
                {selected.config.capabilities.businessPlugins.length ? (
                  <ol className="grid gap-2">
                    {selected.config.capabilities.businessPlugins.map((id, index) => {
                      const plugin = options?.businessPlugins.find((item) => item.id === id);
                      return (
                        <li key={id} className="rounded-md bg-muted/40 p-3">
                          <div className="text-sm font-medium">{index + 1}. {plugin?.label ?? id}</div>
                          <div className="mt-1 break-all text-xs text-muted-foreground">{id}</div>
                          {plugin?.description && <p className="mt-1 text-sm text-muted-foreground">{plugin.description}</p>}
                          {!plugin && options && <p className="mt-1 text-xs text-destructive">当前插件不可用</p>}
                        </li>
                      );
                    })}
                  </ol>
                ) : <p className="text-sm text-muted-foreground">未启用业务插件</p>}
              </div>

              <SpaceTaskUsagePanel key={selected.id} spaceId={selected.id} load={loadUsage} />

              {selected.mode === 'external' && (
                <ExternalCallersPanel key={selected.id} api={api} space={selected} />
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">选择或创建一个空间</div>
          )}
        </div>
      </CardContent>

      <SpaceEditorDialog
        open={editorOpen}
        space={editingSpace}
        options={options}
        users={users}
        saving={saving}
        error={editorError}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditingSpace(null);
        }}
        onSave={saveSpace}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>永久删除空间</DialogTitle>
            <DialogDescription>将永久删除 {deleteTarget?.name} 及其全部会话、运行记录、凭证和文件。</DialogDescription>
          </DialogHeader>
          {deleteTarget?.isDefault && (
            <div className="grid gap-2">
              <div className="text-sm font-medium">新的默认空间</div>
              <Select value={replacementDefaultSpaceId} onValueChange={setReplacementDefaultSpaceId}>
                <SelectTrigger><SelectValue placeholder="选择 Web 空间" /></SelectTrigger>
                <SelectContent>
                  {spaces.filter((space) => space.id !== deleteTarget.id && space.mode === 'web').map((space) => (
                    <SelectItem key={space.id} value={space.id}>{space.name} · {space.id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => void deleteSpace()}
              disabled={deleting || Boolean(deleteTarget?.isDefault && !replacementDefaultSpaceId)}
            >
              {deleting ? '删除中…' : '永久删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
