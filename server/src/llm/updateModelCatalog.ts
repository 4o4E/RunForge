import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  generateModelCatalog,
  MODELS_DEV_ALIAS_SOURCE_URL,
  MODELS_DEV_SOURCE_URL,
  type ModelCatalogDocument,
} from './modelCatalogGenerator.js';

const outputUrl = new URL('./model-catalog.json', import.meta.url);
const checkOnly = process.argv.slice(2).includes('--check');

async function readCurrent(): Promise<{ text: string; document: ModelCatalogDocument | null }> {
  try {
    const text = await readFile(outputUrl, 'utf8');
    return { text, document: JSON.parse(text) as ModelCatalogDocument };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', document: null };
    throw error;
  }
}

const [modelsResponse, aliasesResponse] = await Promise.all([
  fetch(MODELS_DEV_SOURCE_URL, { signal: AbortSignal.timeout(30_000) }),
  fetch(MODELS_DEV_ALIAS_SOURCE_URL, { signal: AbortSignal.timeout(30_000) }),
]);
if (!modelsResponse.ok) throw new Error(`获取 models.dev 模型目录失败：HTTP ${modelsResponse.status}`);
if (!aliasesResponse.ok) throw new Error(`获取 models.dev 模型别名失败：HTTP ${aliasesResponse.status}`);
const [modelsBody, aliasesBody] = await Promise.all([modelsResponse.text(), aliasesResponse.text()]);
const revision = `sha256:${createHash('sha256').update(modelsBody).update('\u0000').update(aliasesBody).digest('hex')}`;
const current = await readCurrent();
const checkedAt = current.document?.source?.revision === revision
  ? current.document.source.checkedAt
  : new Date().toISOString().slice(0, 10);
const document = generateModelCatalog(JSON.parse(modelsBody), JSON.parse(aliasesBody), { revision, checkedAt });
const rendered = `${JSON.stringify(document, null, 2)}\n`;

if (checkOnly) {
  if (current.text !== rendered) {
    throw new Error('本地模型目录已过期，请运行 pnpm model-catalog:update');
  }
  console.log(`模型目录已是最新版本：${document.source.includedModels}/${document.source.totalModels}`);
} else {
  await writeFile(outputUrl, rendered, 'utf8');
  console.log(`已更新模型目录：${document.source.includedModels}/${document.source.totalModels}`);
}
