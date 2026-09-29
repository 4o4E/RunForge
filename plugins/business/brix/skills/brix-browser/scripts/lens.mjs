import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureBundledScript } from './bundled-scripts.mjs';
import { createWorkloadBrixClient } from './workload-client.mjs';

const SCRIPT_NAME = 'google-lens';

function imageMimeType(path) {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.tif':
    case '.tiff': return 'image/tiff';
    default: return 'image/png';
  }
}

export async function execute(imagePath, options = {}) {
  const absoluteImagePath = resolve(imagePath);
  const bytes = await readFile(absoluteImagePath);
  if (!bytes.length) throw new Error('图片文件为空');
  const client = options.client ?? await createWorkloadBrixClient();
  if (options.scriptPath) {
    await client.ensureScript(SCRIPT_NAME, await readFile(options.scriptPath, 'utf8'), 'ts');
  } else {
    await ensureBundledScript(client, SCRIPT_NAME);
  }
  return client.runScript(SCRIPT_NAME, {
    image: `data:${imageMimeType(absoluteImagePath)};base64,${bytes.toString('base64')}`,
  });
}

async function main() {
  const [imagePath] = process.argv.slice(2);
  if (!imagePath) throw new Error('用法：lens.mjs <图片路径>');
  console.log(JSON.stringify(await execute(imagePath)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
