import { readFileSync } from 'node:fs';
import type { LlmInputModality, LlmModelCapabilitySettings } from '@runforge/contracts';

interface CatalogEntry {
  vendor: string;
  version: string;
  aliases?: string[];
  contextWindow: number;
  inputModalities: LlmInputModality[];
}

const KNOWN_MODALITIES = new Set<LlmInputModality>(['text', 'image', 'audio', 'video']);
const DEFAULT_CAPABILITY: Omit<LlmModelCapabilitySettings, 'model'> = {
  contextWindow: 128_000,
  contextWindowSource: 'default',
  inputModalities: ['text'],
  inputModalitiesSource: 'default',
};

const catalog = JSON.parse(readFileSync(new URL('./model-catalog.json', import.meta.url), 'utf8')) as CatalogEntry[];

function modelNames(model: string): string[] {
  const normalized = normalizeModelName(model);
  const leaf = normalizeModelName(model.split('/').at(-1) ?? model);
  return [...new Set([normalized, leaf])];
}

/** 供应商常把版本里的点号或空格改成短横线，统一后再按完整 token 边界匹配。 */
export function normalizeModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchScore(entry: CatalogEntry, names: string[]): number {
  const identities = [entry.version, ...(entry.aliases ?? []), `${entry.vendor} ${entry.version}`]
    .map(normalizeModelName)
    .filter(Boolean);
  return Math.max(-1, ...identities.map((identity) => {
    const matched = names.some((name) => name === identity
      || name.startsWith(`${identity}-`)
      || name.endsWith(`-${identity}`)
      || name.includes(`-${identity}-`));
    return matched ? identity.length : -1;
  }));
}

function findCatalogEntry(model: string): CatalogEntry | undefined {
  const names = modelNames(model);
  return catalog
    .map((entry) => ({ entry, score: matchScore(entry, names) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.entry;
}

function normalizeModalities(value: unknown): LlmInputModality[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((item) => {
    const modality = String(item).trim().toLowerCase();
    if (modality === 'vision' || modality === 'images') return ['image' as const];
    if (modality === 'audios') return ['audio' as const];
    if (modality === 'videos') return ['video' as const];
    return KNOWN_MODALITIES.has(modality as LlmInputModality) ? [modality as LlmInputModality] : [];
  });
  return [...new Set<LlmInputModality>(['text', ...normalized])];
}

/** 静态目录用于补齐上游没有返回的模型能力，未知模型使用保守默认值。 */
export function catalogCapability(model: string): LlmModelCapabilitySettings {
  const matched = findCatalogEntry(model);
  return {
    model,
    contextWindow: matched?.contextWindow ?? DEFAULT_CAPABILITY.contextWindow,
    contextWindowSource: matched ? 'catalog' : 'default',
    inputModalities: normalizeModalities(matched?.inputModalities ?? DEFAULT_CAPABILITY.inputModalities),
    inputModalitiesSource: matched ? 'catalog' : 'default',
  };
}

/** 上游元数据优先，缺失字段才由静态目录补齐。 */
export function mergeModelCapability(
  model: string,
  upstream: Partial<Omit<LlmModelCapabilitySettings, 'model'>> = {},
): LlmModelCapabilitySettings {
  const fallback = catalogCapability(model);
  const modalities = normalizeModalities(upstream.inputModalities);
  return {
    model,
    contextWindow: Number.isFinite(upstream.contextWindow) && Number(upstream.contextWindow) > 0
      ? Math.floor(Number(upstream.contextWindow))
      : fallback.contextWindow,
    contextWindowSource: Number.isFinite(upstream.contextWindow) && Number(upstream.contextWindow) > 0
      ? upstream.contextWindowSource ?? 'provider'
      : fallback.contextWindowSource,
    inputModalities: modalities.length ? modalities : fallback.inputModalities,
    inputModalitiesSource: modalities.length ? upstream.inputModalitiesSource ?? 'provider' : fallback.inputModalitiesSource,
  };
}
