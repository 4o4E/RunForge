import type {
  CreateSpaceInput,
  SpaceMode,
  SpaceDebugMcpSchema,
  SpaceDebugView,
  PromptPlaceholdersView,
  SpaceSummary,
  TenantUserRole,
  UpdateSpaceInput,
} from '@runforge/contracts';
import type { IdentityContext } from '../auth/context.js';
import type { SpaceWithVisibilityRow, Store, UserRow } from '../store/types.js';
import { DefaultSpaceImmutableError } from '../store/types.js';
import { store as defaultStore } from '../store/index.js';
import {
  normalizeSpaceConfig,
  spaceConfigService as defaultSpaceConfigService,
  SpaceConfigError,
  type SpaceConfigService,
} from './config.js';

export class SpaceAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpaceAccessError';
  }
}

type TenantIdentity = Extract<IdentityContext, { scope: 'tenant' }>;
export type SpaceActorContext = TenantIdentity | { scope: 'system'; tenantId: string };

interface ResolvedTenantActor {
  tenantId: string;
  userId: string;
  role: TenantUserRole;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new SpaceAccessError(400, 'SPACE_NAME_REQUIRED', '空间名称不能为空');
  return name;
}

function normalizedUserIds(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new SpaceAccessError(400, 'SPACE_VISIBLE_USERS_INVALID', `${fieldName} 必须是用户 ID 列表`);
  }
  const ids = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (ids.some((id) => !id)) {
    throw new SpaceAccessError(400, 'SPACE_VISIBLE_USERS_INVALID', `${fieldName} 只能包含非空用户 ID`);
  }
  return [...new Set(ids)];
}

function mergeSpaceConfig(current: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const currentModel = isPlainRecord(current.model) ? current.model : {};
  const updateModel = isPlainRecord(update.model) ? update.model : {};
  const currentCapabilities = isPlainRecord(current.capabilities) ? current.capabilities : {};
  const updateCapabilities = isPlainRecord(update.capabilities) ? update.capabilities : {};
  const currentExternal = isPlainRecord(current.external) ? current.external : {};
  const updateExternal = isPlainRecord(update.external) ? update.external : {};
  const merged: Record<string, unknown> = {
    ...current,
    ...update,
    model: { ...currentModel, ...updateModel },
    capabilities: { ...currentCapabilities, ...updateCapabilities },
    external: { ...currentExternal, ...updateExternal },
  };
  if (typeof update.systemPrompt === 'string' && typeof update.promptTemplate !== 'string') {
    delete merged.promptTemplate;
  }
  return merged;
}

export function parseCreateSpaceInput(value: unknown): CreateSpaceInput {
  if (!isPlainRecord(value)) throw new SpaceAccessError(400, 'SPACE_INPUT_INVALID', '请求体必须是对象');
  if (value.mode !== 'web' && value.mode !== 'external') {
    throw new SpaceAccessError(400, 'SPACE_MODE_INVALID', 'mode 必须是 web 或 external');
  }
  const config = value.config === undefined ? {} : value.config;
  if (!isPlainRecord(config)) throw new SpaceAccessError(400, 'SPACE_CONFIG_INVALID', 'config 必须是对象');
  const visibleUserIds = value.visibleUserIds === undefined
    ? []
    : normalizedUserIds(value.visibleUserIds, 'visibleUserIds');
  let executionUserId: string | null = null;
  if (value.executionUserId != null) {
    if (typeof value.executionUserId !== 'string' || !value.executionUserId.trim()) {
      throw new SpaceAccessError(400, 'SPACE_EXECUTION_USER_INVALID', 'executionUserId 必须是用户 ID 或 null');
    }
    executionUserId = value.executionUserId.trim();
  }
  return {
    mode: value.mode,
    name: normalizedName(value.name),
    executionUserId,
    config,
    visibleUserIds,
  };
}

export function parseUpdateSpaceInput(value: unknown): UpdateSpaceInput {
  if (!isPlainRecord(value)) throw new SpaceAccessError(400, 'SPACE_INPUT_INVALID', '请求体必须是对象');
  if (Object.prototype.hasOwnProperty.call(value, 'mode')) {
    throw new SpaceAccessError(400, 'SPACE_MODE_IMMUTABLE', '空间 mode 创建后不能修改');
  }
  const output: UpdateSpaceInput = {};
  if (Object.prototype.hasOwnProperty.call(value, 'name')) output.name = normalizedName(value.name);
  if (Object.prototype.hasOwnProperty.call(value, 'executionUserId')) {
    if (value.executionUserId === null) output.executionUserId = null;
    else if (typeof value.executionUserId === 'string' && value.executionUserId.trim()) {
      output.executionUserId = value.executionUserId.trim();
    } else {
      throw new SpaceAccessError(400, 'SPACE_EXECUTION_USER_INVALID', 'executionUserId 必须是用户 ID 或 null');
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'config')) {
    if (!isPlainRecord(value.config)) throw new SpaceAccessError(400, 'SPACE_CONFIG_INVALID', 'config 必须是对象');
    output.config = value.config;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'visibleUserIds')) {
    output.visibleUserIds = normalizedUserIds(value.visibleUserIds, 'visibleUserIds');
  }
  if (!Object.keys(output).length) throw new SpaceAccessError(400, 'SPACE_UPDATE_EMPTY', '缺少可更新字段');
  return output;
}

function isManager(role: TenantUserRole): boolean {
  return role === 'owner' || role === 'admin';
}

export class SpaceAccessService {
  constructor(
    private readonly store: Store = defaultStore,
    private readonly configService: SpaceConfigService = defaultSpaceConfigService,
  ) {}

  async list(actorContext: SpaceActorContext, includeDeleted = false): Promise<SpaceSummary[]> {
    if (actorContext.scope === 'system') {
      await this.requireTenant(actorContext.tenantId);
      return this.toSummaries(
        actorContext.tenantId,
        await this.store.listSpaces(actorContext.tenantId, { includeDeleted }),
      );
    }
    const actor = await this.resolveTenantActor(actorContext);
    const rows = await this.store.listSpaces(actor.tenantId, { includeDeleted: isManager(actor.role) && includeDeleted });
    const visible = isManager(actor.role)
      ? rows
      : rows.filter((space) => !space.deleted_at && space.visible_user_ids.includes(actor.userId));
    return this.toSummaries(actor.tenantId, visible);
  }

  async get(actorContext: SpaceActorContext, spaceId: string): Promise<SpaceSummary> {
    if (actorContext.scope === 'system') {
      const tenant = await this.requireTenant(actorContext.tenantId);
      return this.toSummary(await this.requireSpace(actorContext.tenantId, spaceId), tenant.default_space_id);
    }
    const actor = await this.resolveTenantActor(actorContext);
    const space = await this.requireSpace(actor.tenantId, spaceId);
    if (!isManager(actor.role) && (space.deleted_at || !space.visible_user_ids.includes(actor.userId))) {
      throw new SpaceAccessError(404, 'SPACE_NOT_FOUND', '空间不存在');
    }
    const tenant = await this.requireTenant(actor.tenantId);
    return this.toSummary(space, tenant.default_space_id);
  }

  async options(actorContext: SpaceActorContext) {
    if (actorContext.scope === 'system') {
      await this.requireTenant(actorContext.tenantId);
      return this.configService.options(actorContext.tenantId);
    }
    const actor = await this.resolveTenantActor(actorContext);
    return this.configService.options(actor.tenantId);
  }

  async create(actorContext: SpaceActorContext, input: CreateSpaceInput): Promise<SpaceSummary> {
    const actor = await this.resolveManagerActor(actorContext);
    return this.createManaged(actor.tenantId, actor.createdByUserId, input);
  }

  async update(actorContext: SpaceActorContext, spaceId: string, input: UpdateSpaceInput): Promise<SpaceSummary> {
    const actor = await this.resolveManagerActor(actorContext);
    return this.updateManaged(actor.tenantId, spaceId, input);
  }

  async delete(actorContext: SpaceActorContext, spaceId: string): Promise<SpaceSummary> {
    const actor = await this.resolveManagerActor(actorContext);
    return this.deleteManaged(actor.tenantId, spaceId);
  }

  async restore(actorContext: SpaceActorContext, spaceId: string): Promise<SpaceSummary> {
    const actor = await this.resolveManagerActor(actorContext);
    return this.restoreManaged(actor.tenantId, spaceId);
  }

  /** caller/Token 等空间控制面复用同一管理权限，不在各业务服务重复判断角色。 */
  async requireManagedSpace(actorContext: SpaceActorContext, spaceId: string): Promise<SpaceSummary> {
    const actor = await this.resolveManagerActor(actorContext);
    const tenant = await this.requireTenant(actor.tenantId);
    return this.toSummary(await this.requireSpace(actor.tenantId, spaceId), tenant.default_space_id);
  }

  async debugView(actorContext: SpaceActorContext, spaceId: string): Promise<SpaceDebugView> {
    const space = await this.requireManagedSpace(actorContext, spaceId);
    try {
      return await this.configService.debugView(
        space.tenantId,
        space.configVersion,
        space.mode,
        space.config,
      );
    } catch (error) {
      if (error instanceof SpaceConfigError) throw new SpaceAccessError(409, error.code, error.message);
      throw error;
    }
  }

  async promptPlaceholders(
    actorContext: SpaceActorContext,
    spaceId: string,
  ): Promise<PromptPlaceholdersView> {
    const space = await this.requireManagedSpace(actorContext, spaceId);
    try {
      return await this.configService.promptPlaceholders(space.tenantId, space.mode, space.config);
    } catch (error) {
      if (error instanceof SpaceConfigError) throw new SpaceAccessError(409, error.code, error.message);
      throw error;
    }
  }

  async debugMcpSchema(
    actorContext: SpaceActorContext,
    spaceId: string,
    mcpId: string,
  ): Promise<SpaceDebugMcpSchema> {
    const space = await this.requireManagedSpace(actorContext, spaceId);
    try {
      return await this.configService.debugMcpSchema(space.tenantId, space.config, mcpId);
    } catch (error) {
      if (error instanceof SpaceConfigError) throw new SpaceAccessError(409, error.code, error.message);
      throw error;
    }
  }

  /** Web 创建和修改 thread 前统一走这里；external 空间即使管理员可见也始终只读。 */
  async requireWritableWebSpace(identity: TenantIdentity, requestedSpaceId?: string | null): Promise<SpaceSummary> {
    const actor = await this.resolveTenantActor(identity);
    const tenant = await this.requireTenant(actor.tenantId);
    const spaceId = requestedSpaceId ?? tenant.default_space_id;
    if (!spaceId) throw new SpaceAccessError(409, 'DEFAULT_SPACE_MISSING', '当前 tenant 缺少 default 空间');
    const space = await this.requireSpace(actor.tenantId, spaceId);
    if (space.deleted_at) throw new SpaceAccessError(409, 'SPACE_DELETED', '空间已删除');
    if (space.mode !== 'web') throw new SpaceAccessError(403, 'SPACE_READ_ONLY', '外部空间在 Web 中只读');
    if (!isManager(actor.role) && !space.visible_user_ids.includes(actor.userId)) {
      throw new SpaceAccessError(404, 'SPACE_NOT_FOUND', '空间不存在');
    }
    return this.toSummary(space, tenant.default_space_id);
  }

  private async createManaged(tenantId: string, createdByUserId: string | null, input: CreateSpaceInput): Promise<SpaceSummary> {
    const executionUserId = await this.validateExecutionUser(tenantId, input.mode, input.executionUserId ?? null);
    const visibleUserIds = await this.validateVisibleUsers(tenantId, input.visibleUserIds ?? []);
    const config = await this.snapshotConfigForCreate(tenantId, input.mode, input.config ?? {});
    const row = await this.store.createSpace({
      tenantId,
      mode: input.mode,
      name: input.name,
      executionUserId,
      config,
      createdByUserId,
      visibleUserIds,
    });
    const tenant = await this.requireTenant(tenantId);
    return this.toSummary(row, tenant.default_space_id);
  }

  private async updateManaged(tenantId: string, spaceId: string, input: UpdateSpaceInput): Promise<SpaceSummary> {
    const current = await this.requireSpace(tenantId, spaceId);
    if (current.deleted_at) throw new SpaceAccessError(409, 'SPACE_DELETED', '空间已删除，请先恢复后再修改');
    const tenant = await this.requireTenant(tenantId);
    let executionUserId = input.executionUserId;
    if (current.mode === 'external') {
      executionUserId = await this.validateExecutionUser(
        tenantId,
        current.mode,
        input.executionUserId === undefined ? current.execution_user_id : input.executionUserId,
      );
    } else if (input.executionUserId !== undefined && input.executionUserId !== null) {
      throw new SpaceAccessError(400, 'SPACE_EXECUTION_USER_INVALID', 'Web 空间不能设置 execution user');
    }
    const visibleUserIds = input.visibleUserIds === undefined
      ? undefined
      : await this.validateVisibleUsers(tenantId, input.visibleUserIds);
    const config = input.config === undefined
      ? undefined
      : await this.normalizeConfigForSave(
          tenantId,
          current.mode,
          mergeSpaceConfig(current.config, input.config as Record<string, unknown>),
        );
    const updated = await this.store.updateSpace(tenantId, spaceId, {
      name: input.name,
      executionUserId,
      config,
      visibleUserIds,
    });
    if (!updated) throw new SpaceAccessError(404, 'SPACE_NOT_FOUND', '空间不存在');
    return this.toSummary(updated, tenant.default_space_id);
  }

  private async deleteManaged(tenantId: string, spaceId: string): Promise<SpaceSummary> {
    try {
      const deleted = await this.store.softDeleteSpaceAndRevokeTokens(tenantId, spaceId);
      if (!deleted) throw new SpaceAccessError(404, 'SPACE_NOT_FOUND', '空间不存在');
      const tenant = await this.requireTenant(tenantId);
      return this.toSummary(deleted, tenant.default_space_id);
    } catch (error) {
      if (error instanceof DefaultSpaceImmutableError) {
        throw new SpaceAccessError(409, error.code, error.message);
      }
      throw error;
    }
  }

  private async restoreManaged(tenantId: string, spaceId: string): Promise<SpaceSummary> {
    const restored = await this.store.restoreSpace(tenantId, spaceId);
    if (!restored) throw new SpaceAccessError(404, 'SPACE_NOT_FOUND', '空间不存在');
    const tenant = await this.requireTenant(tenantId);
    return this.toSummary(restored, tenant.default_space_id);
  }

  private async resolveTenantActor(identity: TenantIdentity): Promise<ResolvedTenantActor> {
    const user = await this.store.findUserById(identity.userId);
    if (!user || user.tenant_id !== identity.tenantId || user.status !== 'active') {
      throw new SpaceAccessError(403, 'SPACE_ACTOR_DISABLED', '当前用户不可访问空间');
    }
    return { tenantId: user.tenant_id, userId: user.id, role: user.role };
  }

  private async requireManager(identity: TenantIdentity): Promise<ResolvedTenantActor> {
    const actor = await this.resolveTenantActor(identity);
    if (!isManager(actor.role)) {
      throw new SpaceAccessError(403, 'SPACE_MANAGE_FORBIDDEN', '需要 owner 或 admin 权限');
    }
    return actor;
  }

  private async resolveManagerActor(
    actorContext: SpaceActorContext,
  ): Promise<{ tenantId: string; createdByUserId: string | null }> {
    if (actorContext.scope === 'system') {
      await this.requireTenant(actorContext.tenantId);
      return { tenantId: actorContext.tenantId, createdByUserId: null };
    }
    const actor = await this.requireManager(actorContext);
    return { tenantId: actor.tenantId, createdByUserId: actor.userId };
  }

  private async requireTenant(tenantId: string) {
    const tenant = await this.store.findTenant(tenantId);
    if (!tenant) throw new SpaceAccessError(404, 'TENANT_NOT_FOUND', '租户不存在');
    return tenant;
  }

  private async requireSpace(tenantId: string, spaceId: string): Promise<SpaceWithVisibilityRow> {
    const space = await this.store.findSpace(tenantId, spaceId);
    if (!space) throw new SpaceAccessError(404, 'SPACE_NOT_FOUND', '空间不存在');
    return space;
  }

  private async validateExecutionUser(tenantId: string, mode: SpaceMode, userId: string | null): Promise<string | null> {
    if (mode === 'web') {
      if (userId !== null) throw new SpaceAccessError(400, 'SPACE_EXECUTION_USER_INVALID', 'Web 空间不能设置 execution user');
      return null;
    }
    if (!userId) throw new SpaceAccessError(400, 'SPACE_EXECUTION_USER_REQUIRED', '外部空间必须选择 execution user');
    const user = await this.store.findUserById(userId);
    if (!user || user.tenant_id !== tenantId || user.status !== 'active') {
      throw new SpaceAccessError(400, 'SPACE_EXECUTION_USER_INVALID', 'execution user 必须是本 tenant 的 active 用户');
    }
    return user.id;
  }

  private async validateVisibleUsers(tenantId: string, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const users = new Map((await this.store.listUsersByTenant(tenantId)).map((user) => [user.id, user]));
    for (const userId of userIds) {
      const user: UserRow | undefined = users.get(userId);
      if (!user || user.role !== 'member') {
        throw new SpaceAccessError(400, 'SPACE_VISIBLE_USER_INVALID', '可见名单只能包含本 tenant 的 member');
      }
    }
    return [...new Set(userIds)];
  }

  private async normalizeConfigForSave(tenantId: string, mode: SpaceMode, value: unknown) {
    try {
      return await this.configService.normalizeForSave(tenantId, mode, value);
    } catch (error) {
      if (error instanceof SpaceConfigError) throw new SpaceAccessError(400, error.code, error.message);
      throw error;
    }
  }

  private async snapshotConfigForCreate(tenantId: string, mode: SpaceMode, value: unknown) {
    try {
      return await this.configService.snapshotForCreate(tenantId, mode, value);
    } catch (error) {
      if (error instanceof SpaceConfigError) throw new SpaceAccessError(400, error.code, error.message);
      throw error;
    }
  }

  private async toSummaries(tenantId: string, spaces: SpaceWithVisibilityRow[]): Promise<SpaceSummary[]> {
    const tenant = await this.requireTenant(tenantId);
    const summaries = spaces.map((space) => this.toSummary(space, tenant.default_space_id));
    return summaries.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt));
  }

  private toSummary(
    space: SpaceWithVisibilityRow,
    defaultSpaceId: string | null,
  ): SpaceSummary {
    return {
      id: space.id,
      tenantId: space.tenant_id,
      mode: space.mode,
      name: space.name,
      executionUserId: space.execution_user_id,
      config: normalizeSpaceConfig(space.config, space.mode),
      configVersion: space.config_version,
      createdByUserId: space.created_by_user_id,
      visibleUserIds: space.visible_user_ids,
      isDefault: defaultSpaceId === space.id,
      deletedAt: space.deleted_at,
      createdAt: space.created_at,
      updatedAt: space.updated_at,
    };
  }
}

export const spaceAccess = new SpaceAccessService();
