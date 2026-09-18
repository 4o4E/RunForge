import type { LlmInputModality } from '@runforge/contracts';

export const MODELS_DEV_SOURCE_URL = 'https://models.dev/models.json';
export const MODELS_DEV_ALIAS_SOURCE_URL = 'https://models.dev/api.json';

export interface ModelCatalogEntry {
  model: string;
  aliases: string[];
  contextWindow: number;
  compactionThreshold: number;
  maxOutputTokens: number | null;
  inputModalities: LlmInputModality[];
  references: Array<{
    title: string;
    url: string;
    checkedAt: string;
    fields: Array<'contextWindow' | 'inputModalities'>;
  }>;
}

export interface ModelCatalogDocument {
  source: {
    name: 'models.dev';
    url: string;
    aliasUrl: string;
    revision: string;
    checkedAt: string;
    totalModels: number;
    includedModels: number;
    aliases: number;
    excludedModels: Array<{ model: string; reason: 'missing-context-window' }>;
  };
  models: ModelCatalogEntry[];
}

interface ModelsDevModel {
  id: string;
  name: string;
  family?: string;
  releaseDate?: string;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[] };
  weights?: Array<{ url?: string }>;
}

const MODALITY_MAP: Record<string, LlmInputModality> = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
  pdf: 'document',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCatalogName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseModel(model: string, value: unknown): ModelsDevModel {
  if (!isRecord(value) || value.id !== model || typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`models.dev 模型 ${model} 的基础字段无效`);
  }
  const limit = isRecord(value.limit) ? value.limit : undefined;
  const modalities = isRecord(value.modalities) ? value.modalities : undefined;
  const weights = Array.isArray(value.weights)
    ? value.weights.map((item) => isRecord(item) ? item as { url?: string } : {})
    : undefined;
  return {
    id: value.id,
    name: value.name,
    family: typeof value.family === 'string' ? value.family : undefined,
    releaseDate: typeof value.release_date === 'string' ? value.release_date : undefined,
    limit: limit ? {
      context: typeof limit.context === 'number' ? limit.context : undefined,
      output: typeof limit.output === 'number' ? limit.output : undefined,
    } : undefined,
    modalities: modalities ? { input: Array.isArray(modalities.input) ? modalities.input.map(String) : undefined } : undefined,
    weights,
  };
}

function modelBasename(model: string): string {
  return model.split('/').at(-1) ?? model;
}

function huggingFaceAlias(url: string | undefined): string | null {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.hostname !== 'huggingface.co') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts[0] === 'datasets' || parts[0] === 'spaces') return null;
  return `${decodeURIComponent(parts[0]!)}\/${decodeURIComponent(parts[1]!)}`;
}

function addAlias(entry: ModelCatalogEntry, alias: string): void {
  if (normalizeCatalogName(alias) === normalizeCatalogName(entry.model)) return;
  if (entry.aliases.some((item) => normalizeCatalogName(item) === normalizeCatalogName(alias))) return;
  entry.aliases.push(alias);
}

function registerAlias(
  owners: Map<string, ModelCatalogEntry>,
  entry: ModelCatalogEntry,
  alias: string,
): void {
  const normalized = normalizeCatalogName(alias);
  if (!normalized) throw new Error(`模型 ${entry.model} 生成了空别名`);
  const existing = owners.get(normalized);
  if (existing && existing !== entry) {
    throw new Error(`模型目录别名冲突：${alias} 同时属于 ${existing.model} 和 ${entry.model}`);
  }
  owners.set(normalized, entry);
  addAlias(entry, alias);
}

function modelIdentity(model: ModelsDevModel): string | null {
  if (!model.releaseDate) return null;
  return [model.name.trim().toLowerCase(), (model.family ?? '').trim().toLowerCase(), model.releaseDate].join('\u0000');
}

function addProviderAliases(
  input: unknown,
  rows: Array<{ entry: ModelCatalogEntry; source: ModelsDevModel }>,
  owners: Map<string, ModelCatalogEntry>,
): void {
  if (!isRecord(input)) throw new Error('models.dev api.json 顶层必须是对象');
  const byIdentity = new Map<string, ModelCatalogEntry>();
  for (const row of rows) {
    const identity = modelIdentity(row.source);
    if (!identity) continue;
    if (byIdentity.has(identity)) throw new Error(`models.dev 规范模型身份重复：${row.entry.model}`);
    byIdentity.set(identity, row.entry);
  }

  const candidates = new Map<string, Array<{ alias: string; entry: ModelCatalogEntry }>>();
  for (const provider of Object.values(input)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [id, raw] of Object.entries(provider.models)) {
      if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.release_date !== 'string') continue;
      const identity = modelIdentity({
        id,
        name: raw.name,
        family: typeof raw.family === 'string' ? raw.family : undefined,
        releaseDate: raw.release_date,
      });
      const entry = identity ? byIdentity.get(identity) : undefined;
      if (!entry) continue;
      const normalized = normalizeCatalogName(id);
      const group = candidates.get(normalized) ?? [];
      group.push({ alias: id, entry });
      candidates.set(normalized, group);
    }
  }

  for (const [normalized, group] of candidates) {
    const distinct = [...new Set(group.map((candidate) => candidate.entry))];
    if (distinct.length !== 1) continue;
    const existing = owners.get(normalized);
    if (existing && existing !== distinct[0]) continue;
    registerAlias(owners, distinct[0]!, group[0]!.alias);
  }
}

/** 将 models.dev 的供应商无关目录转换为 RunForge 运行时目录。 */
export function generateModelCatalog(
  input: unknown,
  aliasInput: unknown,
  source: { revision: string; checkedAt: string },
): ModelCatalogDocument {
  if (!isRecord(input)) throw new Error('models.dev models.json 顶层必须是对象');
  if (!/^sha256:[0-9a-f]{64}$/.test(source.revision)) throw new Error('models.dev 数据摘要无效');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt)) throw new Error('models.dev 检查日期无效');

  const excludedModels: ModelCatalogDocument['source']['excludedModels'] = [];
  const rows: Array<{ entry: ModelCatalogEntry; source: ModelsDevModel }> = [];
  for (const [model, raw] of Object.entries(input)) {
    const item = parseModel(model, raw);
    const contextWindow = item.limit?.context;
    if (!Number.isInteger(contextWindow) || contextWindow! <= 0) {
      excludedModels.push({ model, reason: 'missing-context-window' });
      continue;
    }
    const sourceModalities = item.modalities?.input;
    if (!sourceModalities?.length) throw new Error(`models.dev 模型 ${model} 缺少输入类型`);
    const inputModalities = [...new Set(sourceModalities.map((modality) => {
      const mapped = MODALITY_MAP[modality];
      if (!mapped) throw new Error(`models.dev 模型 ${model} 包含未知输入类型：${modality}`);
      return mapped;
    }))];
    rows.push({
      source: item,
      entry: {
        model,
        aliases: [],
        contextWindow: contextWindow!,
        compactionThreshold: Math.max(1, Math.floor(contextWindow! * 0.75)),
        maxOutputTokens: Number.isInteger(item.limit?.output) && item.limit!.output! > 0
          ? item.limit!.output!
          : null,
        inputModalities,
        references: [{
          title: `${item.name} · models.dev`,
          url: `https://models.dev/models/${model}`,
          checkedAt: source.checkedAt,
          fields: ['contextWindow', 'inputModalities'],
        }],
      },
    });
  }
  rows.sort((left, right) => left.entry.model < right.entry.model ? -1 : left.entry.model > right.entry.model ? 1 : 0);
  excludedModels.sort((left, right) => left.model < right.model ? -1 : left.model > right.model ? 1 : 0);

  const owners = new Map<string, ModelCatalogEntry>();
  for (const { entry } of rows) registerAlias(owners, entry, entry.model);
  for (const { entry } of rows) registerAlias(owners, entry, modelBasename(entry.model));

  const huggingFaceAliases = new Map<string, Array<{ entry: ModelCatalogEntry; alias: string }>>();
  for (const { entry, source: item } of rows) {
    for (const weight of item.weights ?? []) {
      const alias = huggingFaceAlias(weight.url);
      if (!alias) continue;
      const normalized = normalizeCatalogName(alias);
      const candidates = huggingFaceAliases.get(normalized) ?? [];
      candidates.push({ entry, alias });
      huggingFaceAliases.set(normalized, candidates);
    }
  }
  for (const [normalized, candidates] of huggingFaceAliases) {
    const existing = owners.get(normalized);
    if (existing) continue;
    const distinct = [...new Set(candidates.map((candidate) => candidate.entry))];
    if (distinct.length !== 1) continue;
    registerAlias(owners, distinct[0]!, candidates[0]!.alias);
  }
  addProviderAliases(aliasInput, rows, owners);

  return {
    source: {
      name: 'models.dev',
      url: MODELS_DEV_SOURCE_URL,
      aliasUrl: MODELS_DEV_ALIAS_SOURCE_URL,
      revision: source.revision,
      checkedAt: source.checkedAt,
      totalModels: Object.keys(input).length,
      includedModels: rows.length,
      aliases: rows.reduce((total, row) => total + row.entry.aliases.length, 0),
      excludedModels,
    },
    models: rows.map(({ entry }) => entry),
  };
}
