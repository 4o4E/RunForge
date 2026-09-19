import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  CreateSpaceInput,
  RuntimeCapabilityName,
  SpaceConfigInput,
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

interface Draft {
  name: string;
  mode: SpaceMode;
  executionUserId: string;
  visibleUserIds: string[];
  defaultModelRef: string;
  contextBudget: string;
  allowedModelRefs: string[];
  tools: string[];
  mcpServers: string[];
  businessPlugins: string[];
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
    defaultModelRef: config?.model.defaultModelRef ?? options?.defaultModelRef ?? options?.models[0]?.ref ?? '',
    contextBudget: config?.model.contextBudget == null ? '' : String(config.model.contextBudget),
    allowedModelRefs: config?.model.allowedModelRefs ?? options?.models.map((model) => model.ref) ?? [],
    tools: config?.capabilities.tools ?? options?.tools ?? [],
    mcpServers: config?.capabilities.mcpServers ?? options?.mcpServers.map((server) => server.id) ?? [],
    businessPlugins: config?.capabilities.businessPlugins ?? [],
    runtime: config?.capabilities.runtime ?? options?.runtimeCapabilities ?? [],
    allowTrustedPrompt: config?.external.allowTrustedPrompt ?? false,
    allowNextStep: config?.external.allowNextStep ?? false,
  };
}

function toggleValue<T extends string>(values: T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function includeUnavailable(
  available: Array<{ id: string; label: string }>,
  selected: readonly string[],
): Array<{ id: string; label: string }> {
  const availableIds = new Set(available.map((item) => item.id));
  return [
    ...available,
    ...selected
      .filter((id) => !availableIds.has(id))
      .map((id) => ({ id, label: `${id}（当前不可用）` })),
  ];
}

function unavailableIds(available: readonly string[], selected: readonly string[]): string[] {
  const availableIds = new Set(available);
  return selected.filter((id) => !availableIds.has(id));
}

function OptionGrid({
  values,
  selected,
  onChange,
}: {
  values: Array<{ id: string; label: string }>;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  if (!values.length) return <div className="text-xs text-muted-foreground">当前租户没有可用项</div>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {values.map((item) => (
        <label key={item.id} className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Checkbox
            checked={selected.includes(item.id)}
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
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
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
  const modelValues = includeUnavailable(
    (options?.models ?? []).map((model) => ({ id: model.ref, label: model.label })),
    draft.allowedModelRefs,
  );
  const toolValues = includeUnavailable(
    availableTools.map((tool) => ({ id: tool, label: tool })),
    draft.tools,
  );
  const mcpValues = includeUnavailable(options?.mcpServers ?? [], draft.mcpServers);
  const businessPluginValues = includeUnavailable(
    (options?.businessPlugins ?? []).map((plugin) => ({ id: plugin.id, label: plugin.label })),
    draft.businessPlugins,
  );
  const runtimeValues = includeUnavailable(
    (options?.runtimeCapabilities ?? []).map((capability) => ({ id: capability, label: capability })),
    draft.runtime,
  );
  const unavailableModels = unavailableIds((options?.models ?? []).map((model) => model.ref), draft.allowedModelRefs);
  const unavailableTools = unavailableIds(availableTools, draft.tools);
  const unavailableMcpServers = unavailableIds((options?.mcpServers ?? []).map((server) => server.id), draft.mcpServers);
  const unavailableBusinessPlugins = draft.businessPlugins.filter(
    (id) => !(options?.businessPlugins ?? []).some((plugin) => plugin.id === id),
  );
  const unavailableRuntime = unavailableIds(options?.runtimeCapabilities ?? [], draft.runtime);
  const defaultModelInvalid = !draft.allowedModelRefs.includes(draft.defaultModelRef);
  const explicitModelsEmpty = draft.allowedModelRefs.length === 0;
  const executionUserMissing = draft.mode === 'external' && !draft.executionUserId;
  const canSave = Boolean(draft.name.trim())
    && !defaultModelInvalid
    && !explicitModelsEmpty
    && !executionUserMissing
    && unavailableModels.length === 0
    && unavailableTools.length === 0
    && unavailableMcpServers.length === 0
    && unavailableBusinessPlugins.length === 0
    && unavailableRuntime.length === 0
    && !saving;

  function spaceConfig(): SpaceConfigInput {
    const contextBudget = draft.contextBudget.trim() ? Number(draft.contextBudget) : null;
    return {
      schemaVersion: 3,
      model: {
        defaultModelRef: draft.defaultModelRef,
        allowedModelRefs: draft.allowedModelRefs,
        contextBudget: Number.isInteger(contextBudget) && Number(contextBudget) > 0 ? Number(contextBudget) : null,
      },
      capabilities: {
        tools: draft.tools.filter((tool) => availableTools.includes(tool)),
        mcpServers: draft.mcpServers,
        businessPlugins: draft.businessPlugins,
        runtime: draft.runtime,
      },
      external: {
        allowTrustedPrompt: draft.mode === 'external' && draft.allowTrustedPrompt,
        allowNextStep: draft.mode === 'external' && draft.allowNextStep,
      },
    };
  }

  function submit() {
    if (!canSave) return;
    const config = spaceConfig();
    if (space) {
      onSave({
        name: draft.name.trim(),
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
            新建时会复制租户当前可用能力，保存后由空间独立维护选择列表。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">名称</span>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">模式</span>
              <Select
                value={draft.mode}
                disabled={Boolean(space)}
                onValueChange={(value) => {
                  const mode = value as SpaceMode;
                  setDraft({
                    ...draft,
                    mode,
                    executionUserId: mode === 'web' ? '' : draft.executionUserId,
                  });
                }}
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
              onChange={(visibleUserIds) => setDraft({ ...draft, visibleUserIds })}
            />
          </div>

          <CapabilitySection
            label="主 Agent 模型"
            description="默认模型必须在允许列表中；上下文预算为空时使用系统计算值。"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Select value={draft.defaultModelRef} onValueChange={(defaultModelRef) => setDraft({ ...draft, defaultModelRef })}>
                <SelectTrigger><SelectValue placeholder="默认模型" /></SelectTrigger>
                <SelectContent>
                  {modelValues.map((model) => (
                    <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>
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
              values={modelValues}
              selected={draft.allowedModelRefs}
              onChange={(allowedModelRefs) => setDraft({ ...draft, allowedModelRefs })}
            />
            {(defaultModelInvalid || explicitModelsEmpty) && (
              <div className="text-xs text-destructive">
                {explicitModelsEmpty ? '模型列表至少选择一项。' : '默认模型必须包含在允许列表中。'}
              </div>
            )}
            {unavailableModels.length > 0 && (
              <div className="text-xs text-destructive">当前不可用的模型必须取消选择后才能保存空间。</div>
            )}
          </CapabilitySection>

          <CapabilitySection label="工具" description="external 模式固定不暴露 ask_user。">
            <OptionGrid values={toolValues} selected={draft.tools} onChange={(tools) => setDraft({ ...draft, tools })} />
            {unavailableTools.length > 0 && (
              <div className="text-xs text-destructive">当前不可用的工具必须取消选择后才能保存空间。</div>
            )}
          </CapabilitySection>

          <CapabilitySection label="MCP Server" description="只显示 tenant 当前已启用的 MCP 服务。">
            <OptionGrid values={mcpValues} selected={draft.mcpServers} onChange={(mcpServers) => setDraft({ ...draft, mcpServers })} />
            {unavailableMcpServers.length > 0 && (
              <div className="text-xs text-destructive">当前不可用的 MCP Server 必须取消选择后才能保存空间。</div>
            )}
          </CapabilitySection>

          <div className="grid gap-2 rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">业务插件</div>
              <div className="text-xs text-muted-foreground">业务插件包含成组的 Skill、MCP 和运行资源，必须显式启用。</div>
            </div>
            <OptionGrid
              values={businessPluginValues}
              selected={draft.businessPlugins}
              onChange={(businessPlugins) => setDraft({ ...draft, businessPlugins })}
            />
            {unavailableBusinessPlugins.length > 0 && (
              <div className="text-xs text-destructive">当前不可用的业务插件必须取消选择后才能保存空间。</div>
            )}
          </div>

          <CapabilitySection label="运行时能力" description="包括数据源临时凭证、LLM、图片和视频能力。">
            <OptionGrid
              values={runtimeValues}
              selected={draft.runtime}
              onChange={(runtime) => setDraft({ ...draft, runtime: runtime as RuntimeCapabilityName[] })}
            />
            {unavailableRuntime.length > 0 && (
              <div className="text-xs text-destructive">当前不可用的运行时能力必须取消选择后才能保存空间。</div>
            )}
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
