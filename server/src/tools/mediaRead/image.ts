import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import sharp from 'sharp';
import type { LlmContentPart } from '../../llm/types.js';
import type { ToolRunContext } from '../types.js';
import { isWithin } from '../policy.js';
import { toRemotePath } from '../../files/workspace.js';
import { MAX_IMAGE_BYTES, MAX_VIDEO_FRAMES, saveDerivedImage, throwIfAborted } from './shared.js';

const DIRECT_IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export async function readImage(path: string, actualMimeType: string, ctx?: ToolRunContext): Promise<{ text: string; contentParts: LlmContentPart[] }> {
  const info = await stat(path);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节读取上限`);
  const suffix = extname(path).toLowerCase();
  const bytes = await readFile(path);
  throwIfAborted(ctx);
  const expectedMimeType = suffix === '.jpg' || suffix === '.jpeg' ? 'image/jpeg' : `image/${suffix.slice(1)}`;
  if (DIRECT_IMAGE_TYPES.has(suffix) && actualMimeType === expectedMimeType) {
    return {
      text: `已读取图片 ${path}（${info.size} 字节）供视觉分析。`,
      contentParts: [{
        type: 'image', data: bytes.toString('base64'), mimeType: actualMimeType,
        path: ctx?.userFiles && isWithin(ctx.userFiles.source, path)
          ? path
          : toRemotePath(path, ctx?.settings?.workspaceRoot ?? path),
        name: path.split(/[\\/]/).at(-1),
      }],
    };
  }
  const image = sharp(bytes, { animated: false, limitInputPixels: 24_000_000 });
  const metadata = await image.metadata();
  throwIfAborted(ctx);
  if (!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸');
  const converted = await image.rotate().png().toBuffer();
  throwIfAborted(ctx);
  const part = await saveDerivedImage(converted, path, ctx);
  return { text: `已将静态图片转换为 PNG 并交给视觉模型分析：${path}`, contentParts: [part] };
}

/** 动画文件的每一帧按实际播放时长定位，避免只把首帧交给视觉模型。 */
export async function readAnimatedImage(
  path: string,
  options: { mode: string; timeRange?: { startSeconds: number; endSeconds: number }; maxFrames?: number },
  ctx?: ToolRunContext,
): Promise<{ text: string; contentParts?: LlmContentPart[] }> {
  const info = await stat(path);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节读取上限`);
  const metadata = await sharp(path).metadata();
  const pages = metadata.pages ?? 1;
  const delays = Array.from({ length: pages }, (_, index) => Math.max(10, metadata.delay?.[index] ?? 100));
  const duration = delays.reduce((total, delay) => total + delay, 0) / 1000;
  const start = options.timeRange?.startSeconds ?? 0;
  const end = options.timeRange?.endSeconds ?? duration;
  if (start < 0 || end <= start || end > duration) throw new Error(`动画时间范围必须位于 0 到 ${duration.toFixed(2)} 秒之间`);
  if (options.mode === 'metadata') return { text: `动画元信息：${pages} 帧，时长 ${duration.toFixed(2)} 秒，画面 ${metadata.width ?? '未知'}×${metadata.pageHeight ?? metadata.height ?? '未知'}。` };
  const frameCount = options.maxFrames ?? 4;
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_VIDEO_FRAMES) throw new Error(`一次最多抽取 ${MAX_VIDEO_FRAMES} 张动画画面`);
  const timestamps = options.mode === 'text' ? [] : Array.from({ length: frameCount }, (_, index) => start + (end - start) * (index + 1) / (frameCount + 1));
  const images: LlmContentPart[] = [];
  for (const timestamp of timestamps) {
    throwIfAborted(ctx);
    let elapsed = 0;
    let page = pages - 1;
    for (let index = 0; index < pages; index++) {
      elapsed += delays[index] / 1000;
      if (timestamp < elapsed) { page = index; break; }
    }
    const bytes = await sharp(path, { page, limitInputPixels: 24_000_000 }).png().toBuffer();
    const image = await saveDerivedImage(bytes, `${path}-${timestamp.toFixed(2)}s`, ctx);
    image.name = `${timestamp.toFixed(2)} 秒`;
    images.push(image);
  }
  return {
    text: `动画总时长 ${duration.toFixed(2)} 秒，共 ${pages} 帧。本次实际抽取画面：${timestamps.map((timestamp) => `${timestamp.toFixed(2)} 秒`).join('、') || '未抽取画面'}。画面仅为时间抽样，不能代表全部动画。`,
    ...(images.length ? { contentParts: images } : {}),
  };
}
