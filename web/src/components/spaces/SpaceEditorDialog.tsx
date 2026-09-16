import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  CreateSpaceInput,
  RuntimeCapabilityName,
  SpaceMode,
  SpaceOptions,
  SpaceSummary,
  TenantUserSummary,
  UpdateSpaceInput,
} from '@runforge/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const INHERIT_MODEL = '__inherit__';

interface Draft {
  name: string;
  mode: SpaceMode;
  executionUserId: string;
  visibleUserIds: string[];
  systemPrompt: string;
  defaultModelRef: string;
  contextBudget: string;
  inheritModels: boolean;
  allowedModelRefs: string[];
  inheritTools: boolean;
  tools: string[];
  inheritMcp: boolean;
  mcpServers: string[];
  inheritRuntime: boolean;
  runtime: RuntimeCapabilityName[];
  allowTrustedPrompt: boolean;
  allowNextStep: boolean;
}

interface Props {
  open: boolean;
  space: SpaceSummary | null;
  options: SpaceOptions | null;
  users: TenantUserSummary[];
  saving: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onSave: (input: CreateSpaceInput | UpdateSpaceInput) => void;
}

function initialDraft(space: SpaceSummary | null, options: SpaceOptions | null): Draft {
  const config = space?.config;
  return {
    name: space?.name ?? '',
    mode: space?.mode ?? 'web',
    executionUserId: space?.executionUserId ?? '',
    visibleUserIds: space?.visibleUserIds ?? [],
    systemPrompt: config?.systemPrompt ?? '',
    defaultModelRef: config?.model.defaultModelRef ?? INHERIT_MODEL,
    contextBudget: config?.model.contextBudget == null ? '' : String(config.model.contextBudget),
    inheritModels: config?.model.allowedModelRefs == null,
    allowedModelRefs: config?.model.allowedModelRefs ?? options?.models.map((model) => model.ref) ?? [],
    inheritTools: config?.capabilities.tools == null,
    tools: config?.capabilities.tools ?? options?.tools ?? [],
    inheritMcp: config?.capabilities.mcpServers == null,
    mcpServers: config?.capabilities.mcpServers ?? options?.mcpServers.map((server) => server.id) ?? [],
    inheritRuntime: config?.capabilities.runtime == null,
    runtime: config?.capabilities.runtime ?? options?.runtimeCapabilities ?? [],
    allowTrustedPrompt: config?.external.allowTrustedPrompt ?? false,
    allowNextStep: config?.external.allowNextStep ?? false,
  };
}

function toggleValue<T extends string>(values: T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function OptionGrid({
  values,
  selected,
  disabled,
  onChange,
}: {
  values: Array<{ id: string; label: string }>;
  selected: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  if (!values.length) return <div className="text-xs text-muted-foreground">当前租户没有可用项</div>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {values.map((item) => (
        <label key={item.id} className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Checkbox
            checked={selected.includes(item.id)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(toggleValue(selected, item.id, checked))}
          />
          <span className="min-w-0 truncate" title={item.id}>{item.label}</span>
        </label>
      ))}
    </div>
  );
}

function CapabilitySection({
  label,
  description,
  inherit,
  onInheritChange,
  children,
}: {
  label: string;
  description: string;
  inherit: boolean;
  onInheritChange: (value: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={inherit} onCheckedChange={onInheritChange} />
          自动继承
        </label>
      </div>
      {children}
    </div>
  );
}

export function SpaceEditorDialog({ open, space, options, users, saving, error, onOpenChange, onSave }: Props) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(space, options));
  useEffect(() => {
    if (open) setDraft(initialDraft(space, options));
  }, [open, options, space]);

  const activeUsers = users.filter((user) => user.status === 'active');
  const visibleMembers = users.filter((user) => user.role === 'member');
  const availableTools = useMemo(
    () => (options?.tools ?? []).filter((tool) => draft.mode !== 'external' || tool !== 'ask_user'),
    [draft.mode, options?.tools],
  );
  const defaultModelInvalid = draft.defaultModelRef !== INHERIT_MODEL
    && !draft.inheritModels
    && !draft.allowedModelRefs.includes(draft.defaultModelRef);
  const explicitModelsEmpty = !draft.inheritModels && draft.allowedModelRefs.length === 0;
  const executionUserMissing = draft.mode === 'external' && !draft.executionUserId;
  const canSave = Boolean(draft.name.trim()) && !defaultModelInvalid && !explicitModelsEmpty && !executionUserMissing && !saving;

  function submit() {
    if (!canSave) return;
    const contextBudget = draft.contextBudget.trim() ? Number(draft.contextBudget) : null;
    const config = {
      schemaVersion: 1 as const,
      systemPrompt: draft.systemPrompt,
      model: {
        defaultModelRef: draft.defaultModelRef === INHERIT_MODEL ? null : draft.defaultModelRef,
        allowedModelRefs: draft.inheritModels ? null : draft.allowedModelRefs,
        contextBudget: Number.isInteger(contextBudget) && Number(contextBudget) > 0 ? Number(contextBudget) : null,
      },
      capabilities: {
        tools: draft.inheritTools ? null : draft.tools.filter((tool) => availableTools.includes(tool)),
        mcpServers: draft.inheritMcp ? null : draft.mcpServers,
        runtime: draft.inheritRuntime ? null : draft.runtime,
      },
      external: {
        allowTrustedPrompt: draft.mode === 'external' && draft.allowTrustedPrompt,
        allowNextStep: draft.mode === 'external' && draft.allowNextStep,
      },
    };
    if (space) {
      onSave({
        ...(!space.isDefault ? { name: draft.name.trim() } : {}),
        ...(space.mode === 'external' ? { executionUserId: draft.executionUserId } : {}),
        visibleUserIds: draft.visibleUserIds,
        config,
      });
      return;
    }
    onSave({
      name: draft.name.trim(),
      mode: draft.mode,
      ...(draft.mode === 'external' ? { executionUserId: draft.executionUserId } : {}),
      visibleUserIds: draft.visibleUserIds,
      config,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{space ? '编辑空间' : '新建空间'}</DialogTitle>
          <DialogDescription>
            自动继承表示每次创建 run 时使用 tenant 当时可用的完整目录；关闭后固定为空间选择的子集。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">名称</span>
              <Input
                value={draft.name}
                disabled={space?.isDefault}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">模式</span>
              <Select
                value={draft.mode}
                disabled={Boolean(space)}
                onValueChange={(mode) => setDraft({ ...draft, mode: mode as SpaceMode, executionUserId: mode === 'web' ? '' : draft.executionUserId })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="web">Web 对话</SelectItem>
                  <SelectItem value="external">外部运行（Web 只读）</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          {draft.mode === 'external' && (
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">执行用户</span>
              <Select value={draft.executionUserId} onValueChange={(executionUserId) => setDraft({ ...draft, executionUserId })}>
                <SelectTrigger><SelectValue placeholder="选择本租户 active 用户" /></SelectTrigger>
                <SelectContent>
                  {activeUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>{user.email} · {user.role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">只决定新 thread/run 的执行身份，不产生空间管理权限。</span>
            </label>
          )}

          <div className="grid gap-2 rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">普通用户可见名单</div>
              <div className="text-xs text-muted-foreground">owner/admin 始终可见；名单为空时其他用户不可见。</div>
            </div>
            <OptionGrid
              values={visibleMembers.map((user) => ({ id: user.id, label: `${user.email}${user.status === 'disabled' ? ' · 已禁用' : ''}` }))}
              selected={draft.visibleUserIds}
              disabled={false}
              onChange={(visibleUserIds) => setDraft({ ...draft, visibleUserIds })}
            />
          </div>

          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">系统提示词</span>
            <Textarea
              className="min-h-28"
              value={draft.systemPrompt}
              onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
              placeholder="为空时不追加空间级提示词"
            />
          </label>

          <CapabilitySection
            label="主 Agent 模型"
            description="默认模型必须在允许列表中；上下文预算为空时使用系统计算值。"
            inherit={draft.inheritModels}
            onInheritChange={(inheritModels) => setDraft({ ...draft, inheritModels })}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Select value={draft.defaultModelRef} onValueChange={(defaultModelRef) => setDraft({ ...draft, defaultModelRef })}>
                <SelectTrigger><SelectValue placeholder="默认模型" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_MODEL}>继承 tenant 默认模型</SelectItem>
                  {(options?.models ?? []).map((model) => (
                    <SelectItem key={model.ref} value={model.ref}>{model.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={1}
                value={draft.contextBudget}
                onChange={(event) => setDraft({ ...draft, contextBudget: event.target.value })}
                placeholder="上下文预算（自动）"
              />
            </div>
            <OptionGrid
              values={(options?.models ?? []).map((model) => ({ id: model.ref, label: model.label }))}
              selected={draft.allowedModelRefs}
              disabled={draft.inheritModels}
              onChange={(allowedModelRefs) => setDraft({ ...draft, allowedModelRefs })}
            />
            {(defaultModelInvalid || explicitModelsEmpty) && (
              <div className="text-xs text-destructive">
                {explicitModelsEmpty ? '显式模型列表至少选择一项。' : '默认模型必须包含在允许列表中。'}
              </div>
            )}
          </CapabilitySection>

          <CapabilitySection label="工具" description="external 模式固定不暴露 ask_user。" inherit={draft.inheritTools} onInheritChange={(inheritTools) => setDraft({ ...draft, inheritTools })}>
            <OptionGrid values={availableTools.map((tool) => ({ id: tool, label: tool }))} selected={draft.tools} disabled={draft.inheritTools} onChange={(tools) => setDraft({ ...draft, tools })} />
          </CapabilitySection>

          <CapabilitySection label="MCP Server" description="只显示 tenant 当前已启用的 MCP 服务。" inherit={draft.inheritMcp} onInheritChange={(inheritMcp) => setDraft({ ...draft, inheritMcp })}>
            <OptionGrid values={options?.mcpServers ?? []} selected={draft.mcpServers} disabled={draft.inheritMcp} onChange={(mcpServers) => setDraft({ ...draft, mcpServers })} />
          </CapabilitySection>

          <CapabilitySection label="运行时能力" description="包括数据源临时凭证、LLM、图片和视频能力。" inherit={draft.inheritRuntime} onInheritChange={(inheritRuntime) => setDraft({ ...draft, inheritRuntime })}>
            <OptionGrid
              values={(options?.runtimeCapabilities ?? []).map((capability) => ({ id: capability, label: capability }))}
              selected={draft.runtime}
              disabled={draft.inheritRuntime}
              onChange={(runtime) => setDraft({ ...draft, runtime: runtime as RuntimeCapabilityName[] })}
            />
          </CapabilitySection>

          {draft.mode === 'external' && (
            <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3">
                <div><div className="text-sm font-medium">可信提示词</div><div className="text-xs text-muted-foreground">允许调用方传入独立 trustedPrompt。</div></div>
                <Switch checked={draft.allowTrustedPrompt} onCheckedChange={(allowTrustedPrompt) => setDraft({ ...draft, allowTrustedPrompt })} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div><div className="text-sm font-medium">next_step</div><div className="text-xs text-muted-foreground">允许在当前 run 的完整 step 边界追加。</div></div>
                <Switch checked={draft.allowNextStep} onCheckedChange={(allowNextStep) => setDraft({ ...draft, allowNextStep })} />
              </div>
            </div>
          )}

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={!canSave}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
