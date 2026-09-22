import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

const [requestPath, outputPath] = process.argv.slice(2);
if (!requestPath || !outputPath) throw new Error('用法: image.mjs <请求.json> <输出图片路径>');

const request = JSON.parse(await readFile(resolve(requestPath), 'utf8'));
if (request.mode !== 'generate' && request.mode !== 'edit') throw new Error('mode 只能是 generate 或 edit');
if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('prompt 不能为空');

const { RunForgeWorkloadClient } = await import(process.env.RUNFORGE_WORKLOAD_SDK);
const client = new RunForgeWorkloadClient();
const credential = await client.resources.acquire('image.proxy');
const endpoint = credential.endpoints[request.mode];
if (!endpoint) throw new Error(`图片运行能力没有 ${request.mode} 端点`);

const payload = {
  prompt: request.prompt.trim(),
  ...(typeof request.model === 'string' && request.model.trim() ? { model: request.model.trim() } : {}),
  ...(typeof request.size === 'string' && request.size.trim() ? { size: request.size.trim() } : {}),
  n: 1,
};

if (request.mode === 'edit') {
  if (!Array.isArray(request.images) || request.images.length === 0) throw new Error('图片编辑必须提供 images');
  payload.images = await Promise.all(request.images.map(async (path) => {
    if (typeof path !== 'string' || !path.trim()) throw new Error('images 只能包含非空路径');
    const absolute = resolve(path);
    return {
      name: basename(absolute),
      mimeType: imageMimeType(absolute),
      contentBase64: (await readFile(absolute)).toString('base64'),
    };
  }));
}

const response = await fetch(`${credential.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
  method: 'POST',
  headers: { ...credential.headers, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const body = await response.json();
if (!response.ok) throw new Error(`图片生成 HTTP ${response.status}: ${JSON.stringify(body)}`);
const content = body?.data?.[0]?.b64_json;
if (typeof content !== 'string' || !content) throw new Error('图片生成结果缺少 data[0].b64_json');
const target = resolve(outputPath);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, Buffer.from(content, 'base64'));
console.log(target);

function imageMimeType(path) {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'image/png';
  }
}
