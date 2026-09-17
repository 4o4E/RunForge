import { readFileSync } from 'node:fs';
import type {
  LlmInputModality,
  LlmModelCapabilityField,
  LlmModelCapabilityReference,
  LlmModelCapabilitySettings,
} from '@runforge/contracts';

interface CatalogEntry {
  model: string;
  aliases: string[];
  contextWindow: number;
  inputModalities: LlmInputModality[];
  references: LlmModelCapabilityReference[];
}

const KNOWN_MODALITIES = new Set<LlmInputModality>(['text', 'image', 'audio', 'video', 'document']);
const KNOWN_FIELDS = new Set<LlmModelCapabilityField>(['contextWindow', 'inputModalities']);
const catalog = JSON.parse(readFileSync(new URL('./model-catalog.json', import.meta.url), 'utf8')) as CatalogEntry[];

/** 模型名称只统一大小写和分隔符；匹配仍要求完整名称相等。 */
export function normalizeModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateCatalogEntry(entry: CatalogEntry, index: number): void {
  if (!normalizeModelName(entry.model)) throw new Error(`模型能力目录第 ${index + 1} 项缺少模型名称`);
  if (!Number.isInteger(entry.contextWindow) || entry.contextWindow <= 0) {
    throw new Error(`模型能力目录 ${entry.model} 的上下文长度无效`);
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

function findCatalogEntry(model: string): CatalogEntry | undefined {
  return catalogByName.get(normalizeModelName(model));
}

function cloneReferences(references: LlmModelCapabilityReference[]): LlmModelCapabilityReference[] {
  return references.map((reference) => ({ ...reference, fields: [...reference.fields] }));
}

/** 未登记模型返回待人工填写状态，任何字段都不会生成推测值。 */
export function catalogCapability(model: string): LlmModelCapabilitySettings {
  const matched = findCatalogEntry(model);
  if (!matched) {
    return {
      model,
      contextWindow: null,
      contextWindowSource: 'manual',
      inputModalities: [],
      inputModalitiesSource: 'manual',
      references: [],
    };
  }
  return {
    model,
    contextWindow: matched.contextWindow,
    contextWindowSource: 'catalog',
    inputModalities: [...matched.inputModalities],
    inputModalitiesSource: 'catalog',
    references: cloneReferences(matched.references),
  };
}
