import { readFileSync } from 'node:fs';
import type {
  LlmInputModality,
  LlmModelCapabilityField,
  LlmModelCapabilityReference,
  LlmModelCapabilitySettings,
} from '@runforge/contracts';
import type { ModelCatalogDocument, ModelCatalogEntry as CatalogEntry } from './modelCatalogGenerator.js';

const KNOWN_MODALITIES = new Set<LlmInputModality>(['text', 'image', 'audio', 'video', 'document']);
const KNOWN_FIELDS = new Set<LlmModelCapabilityField>(['contextWindow', 'inputModalities']);
const document = JSON.parse(readFileSync(new URL('./model-catalog.json', import.meta.url), 'utf8')) as ModelCatalogDocument;
const catalog = document.models;

/** 模型名称统一大小写和分隔符，供完整名称和后缀名称匹配。 */
export function normalizeModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateCatalogEntry(entry: CatalogEntry, index: number): void {
  if (!normalizeModelName(entry.model)) throw new Error(`模型能力目录第 ${index + 1} 项缺少模型名称`);
  if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => !normalizeModelName(alias))) {
    throw new Error(`模型能力目录 ${entry.model} 的别名无效`);
  }
  if (!Number.isInteger(entry.contextWindow) || entry.contextWindow <= 0) {
    throw new Error(`模型能力目录 ${entry.model} 的上下文长度无效`);
  }
  if (
    !Number.isInteger(entry.compactionThreshold)
    || entry.compactionThreshold <= 0
    || entry.compactionThreshold > entry.contextWindow
  ) {
    throw new Error(`模型能力目录 ${entry.model} 的压缩阈值无效`);
  }
  if (
    entry.maxOutputTokens !== null
    && (!Number.isInteger(entry.maxOutputTokens) || entry.maxOutputTokens <= 0)
  ) {
    throw new Error(`模型能力目录 ${entry.model} 的最大输出长度无效`);
  }
  if (!entry.inputModalities.length || entry.inputModalities.some((item) => !KNOWN_MODALITIES.has(item))) {
    throw new Error(`模型能力目录 ${entry.model} 的输入类型无效`);
  }
  if (!entry.references.length || entry.references.some((reference) => (
    !reference.title.trim()
    || !reference.url.startsWith('https://')
    || !/^\d{4}-\d{2}-\d{2}$/.test(reference.checkedAt)
    || !reference.fields.length
    || reference.fields.some((field) => !KNOWN_FIELDS.has(field))
  ))) {
    throw new Error(`模型能力目录 ${entry.model} 的资料来源无效`);
  }
  for (const field of KNOWN_FIELDS) {
    if (!entry.references.some((reference) => reference.fields.includes(field))) {
      throw new Error(`模型能力目录 ${entry.model} 缺少 ${field} 的资料来源`);
    }
  }
}

function validateCatalogDocument(): void {
  if (
    document.source?.name !== 'models.dev'
    || document.source.url !== 'https://models.dev/models.json'
    || document.source.aliasUrl !== 'https://models.dev/api.json'
    || !/^sha256:[0-9a-f]{64}$/.test(document.source.revision)
    || !/^\d{4}-\d{2}-\d{2}$/.test(document.source.checkedAt)
    || document.source.includedModels !== catalog.length
    || document.source.aliases !== catalog.reduce((total, entry) => total + entry.aliases.length, 0)
    || document.source.totalModels !== catalog.length + document.source.excludedModels.length
  ) {
    throw new Error('模型能力目录的 models.dev 来源信息无效');
  }
}

validateCatalogDocument();

const catalogByName = new Map<string, CatalogEntry>();
for (const [index, entry] of catalog.entries()) {
  validateCatalogEntry(entry, index);
  for (const name of [entry.model, ...entry.aliases]) {
    const normalized = normalizeModelName(name);
    const existing = catalogByName.get(normalized);
    if (existing && existing !== entry) throw new Error(`模型能力目录名称重复：${name}`);
    catalogByName.set(normalized, entry);
  }
}

const catalogMatchers = [...catalogByName.entries()].sort(([left], [right]) => right.length - left.length);

function findCatalogEntry(model: string): CatalogEntry | undefined {
  const normalized = normalizeModelName(model);
  const exact = catalogByName.get(normalized);
  if (exact) return exact;
  return catalogMatchers.find(([name]) => normalized.startsWith(`${name}-`))?.[1];
}

function cloneReferences(references: LlmModelCapabilityReference[]): LlmModelCapabilityReference[] {
  return references.map((reference) => ({ ...reference, fields: [...reference.fields] }));
}

/** Anthropic 协议要求显式提供 max_tokens；返回模型声明的最大值，避免产生额外的本地限制。 */
export function catalogMaxOutputTokens(model: string): number | null {
  return findCatalogEntry(model)?.maxOutputTokens ?? null;
}

/** 未登记模型返回待人工填写状态，任何字段都不会生成推测值。 */
export function catalogCapability(model: string): LlmModelCapabilitySettings {
  const matched = findCatalogEntry(model);
  if (!matched) {
    return {
      model,
      contextWindow: null,
      contextWindowSource: 'manual',
      compactionThreshold: null,
      compactionThresholdSource: 'manual',
      inputModalities: [],
      inputModalitiesSource: 'manual',
      references: [],
    };
  }
  return {
    model,
    contextWindow: matched.contextWindow,
    contextWindowSource: 'catalog',
    compactionThreshold: matched.compactionThreshold,
    compactionThresholdSource: 'catalog',
    inputModalities: [...matched.inputModalities],
    inputModalitiesSource: 'catalog',
    references: cloneReferences(matched.references),
  };
}
