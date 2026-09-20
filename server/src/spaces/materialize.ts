import { store as defaultStore } from '../store/index.js';
import type { SpaceRow, Store } from '../store/types.js';
import { spaceConfigService as defaultConfigService, type SpaceConfigService } from './config.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function needsMaterialization(space: SpaceRow): boolean {
  const config = record(space.config);
  const model = record(config.model);
  const capabilities = record(config.capabilities);
  if (config.schemaVersion !== 3 || typeof config.promptTemplate !== 'string') return true;
  if (!Array.isArray(model.allowedModelRefs)) return true;
  if (model.allowedModelRefs.length > 0 && !(typeof model.defaultModelRef === 'string' && model.defaultModelRef.trim())) return true;
  return !Array.isArray(capabilities.tools)
    || !Array.isArray(capabilities.mcpServers)
    || !Array.isArray(capabilities.businessPlugins)
    || !Array.isArray(capabilities.runtime);
}

/** 将旧空间的 null/缺失选择一次性转换成完整副本，后续不再跟随 tenant 能力目录变化。 */
export async function materializeLegacySpaceConfigs(
  store: Store = defaultStore,
  configService: SpaceConfigService = defaultConfigService,
): Promise<number> {
  let updated = 0;
  for (const tenant of await store.listTenants()) {
    for (const space of await store.listSpaces(tenant.id)) {
      if (!needsMaterialization(space)) continue;
      try {
        const config = await configService.snapshotForCreate(tenant.id, space.mode, space.config, false);
        const saved = await store.updateSpace(tenant.id, space.id, { config });
        if (!saved) throw new Error('空间在转换期间不存在');
        updated += 1;
      } catch (error) {
        throw new Error(`空间 ${space.id} 的旧配置转换失败：${(error as Error).message}`, { cause: error });
      }
    }
  }
  return updated;
}
