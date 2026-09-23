import {
  findModelCatalogEntry,
  generateModelCatalogEntries,
  MODELS_DEV_ALIAS_SOURCE_URL,
  MODELS_DEV_SOURCE_URL,
  type LlmModelCapabilitySettings,
  type ModelCatalogEntry,
} from '@runforge/contracts';

let activeCatalog: Promise<ModelCatalogEntry[]> | null = null;
let loadedAt = 0;

async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
  const [modelsResponse, aliasesResponse] = await Promise.all([
    fetch(MODELS_DEV_SOURCE_URL, { cache: 'no-cache' }),
    fetch(MODELS_DEV_ALIAS_SOURCE_URL, { cache: 'no-cache' }),
  ]);
  if (!modelsResponse.ok) throw new Error(`读取 models.dev 模型资料失败：HTTP ${modelsResponse.status}`);
  if (!aliasesResponse.ok) throw new Error(`读取 models.dev 模型别名失败：HTTP ${aliasesResponse.status}`);
  const [models, aliases] = await Promise.all([modelsResponse.json(), aliasesResponse.json()]);
  return generateModelCatalogEntries(models, aliases, new Date().toISOString().slice(0, 10)).models;
}

async function catalogEntries(refresh: boolean): Promise<ModelCatalogEntry[]> {
  if (refresh || !activeCatalog || Date.now() - loadedAt > 5 * 60_000) {
    activeCatalog = fetchCatalog();
    loadedAt = Date.now();
  }
  const pending = activeCatalog;
  try {
    return await pending;
  } catch (error) {
    if (activeCatalog === pending) {
      activeCatalog = null;
      loadedAt = 0;
    }
    throw error;
  }
}

/** 只在管理员选择或明确刷新模型时读取资料；整份目录仅保存在当前页面内存。 */
export async function resolveModelCapability(model: string, refresh = false): Promise<LlmModelCapabilitySettings> {
  return capabilityFromCatalogEntries(await catalogEntries(refresh), model);
}

export function capabilityFromCatalogEntries(entries: readonly ModelCatalogEntry[], model: string): LlmModelCapabilitySettings {
  const entry = findModelCatalogEntry(entries, model);
  if (!entry) return {
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
  return {
    model,
    contextWindow: entry.contextWindow,
    contextWindowSource: 'catalog',
    compactionThreshold: entry.compactionThreshold,
    compactionThresholdSource: 'catalog',
    maxOutputTokens: entry.maxOutputTokens,
    inputModalities: [...entry.inputModalities],
    inputModalitiesSource: 'catalog',
    references: entry.references.map((reference) => ({ ...reference, fields: [...reference.fields] })),
  };
}
