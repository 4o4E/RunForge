import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileTypeFromFile } from 'file-type';
import sharp from 'sharp';
import type { Tool } from './types.js';
import { resolveToolPath } from './path.js';
import { mediaTypeFromPath, toRemotePath } from '../files/workspace.js';
import { ensureOfficePdfPreview, isOfficeConvertiblePath } from '../files/officePreview.js';
import { transcribeAudio } from './mediaRead/audio.js';
import { readAnimatedImage, readImage } from './mediaRead/image.js';
import { readPdf } from './mediaRead/pdf.js';
import { readVideo } from './mediaRead/video.js';
import { MAX_MEDIA_FILE_BYTES, readTextFile, throwIfAborted } from './mediaRead/shared.js';
import type { ToolRunContext } from './types.js';

interface FileReadOptions {
  mode?: 'text' | 'media' | 'metadata';
  pages?: number[];
  timeRange?: { startSeconds: number; endSeconds: number };
  maxFrames?: number;
}

async function readFileContent(path: string, inputPath: string, options: FileReadOptions, ctx?: ToolRunContext) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`路径不是文件：${inputPath}`);
  throwIfAborted(ctx);
  const detectedType = await fileTypeFromFile(path);
  const mediaType = detectedType?.mime ?? mediaTypeFromPath(path);
  const extension = extname(path).toLowerCase();
  const mode = options.mode ?? (
    mediaType.startsWith('image/') || mediaType.startsWith('video/') || mediaType === 'application/pdf' || extension === '.pdf' || isOfficeConvertiblePath(path)
      ? 'media'
      : 'text'
  );
  if (info.size > MAX_MEDIA_FILE_BYTES) throw new Error(`文件超过 ${MAX_MEDIA_FILE_BYTES} 字节读取上限`);

  if (mediaType.startsWith('image/')) {
    const image = await sharp(path).metadata();
    if ((image.pages ?? 1) > 1) {
      return readAnimatedImage(path, { ...options, mode }, ctx);
    }
    if (mode === 'metadata') return { text: `图片元信息：${mediaType}，${info.size} 字节。` };
    if (mode === 'text') return { text: `这是 ${mediaType} 图片，${info.size} 字节。mode=text 不包含画面像素内容；需要视觉分析时请使用 mode=media。` };
    const result = await readImage(path, mediaType, ctx);
    return result;
  }

  if (mediaType === 'application/pdf' || extension === '.pdf') {
    return readPdf(path, { ...options, mode }, ctx);
  }

  if (isOfficeConvertiblePath(path)) {
    if (!ctx?.scope?.tenantId) throw new Error('Office 文件读取需要租户上下文');
    if (mode === 'metadata') return { text: `Office 文件元信息：${extension.slice(1).toUpperCase()}，${info.size} 字节。` };
    throwIfAborted(ctx);
    const pdfPath = await ensureOfficePdfPreview({
      tenantId: ctx.scope.tenantId,
      workspaceKey: ctx.threadId ?? ctx.runId ?? 'tool-read',
      file: path,
      remotePath: ctx.settings?.workspaceRoot ? toRemotePath(path, ctx.settings.workspaceRoot) : path,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
    throwIfAborted(ctx);
    return readPdf(pdfPath, { ...options, mode }, ctx);
  }

  if (mediaType.startsWith('audio/')) {
    if (mode === 'metadata') return { text: `音频元信息：${mediaType}，${info.size} 字节。使用 mode=text 可读取转写。` };
    if (mode === 'media') throw new Error('音频没有可直接发送给当前对话模型的二进制输入；请使用 mode=text 转写');
    return { text: await transcribeAudio(path, ctx) };
  }

  if (mediaType.startsWith('video/')) return readVideo(path, { ...options, mode }, ctx);
  if (mode === 'metadata') return { text: `文件元信息：${mediaType}，${info.size} 字节。` };
  return { text: await readTextFile(path) };
}

export const fileReadTool: Tool = {
  name: 'file_read',
  description: '统一读取文本、图片、PDF、Office 文档、音频和视频；默认按实际文件类型处理。PDF 和 Office 默认抽取文字并读取少量页面图像；可用 pages 或 timeRange 限定读取范围。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件的绝对路径或相对路径' },
      mode: { type: 'string', enum: ['text', 'media', 'metadata'], description: '未提供时由实际文件类型决定；PDF 的 text 只抽取文字，默认模式还会读取少量页面图像；metadata 只返回格式和大小信息' },
      pages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 8, description: 'PDF 页面或 Office 转换后页面；最多 8 页' },
      timeRange: {
        type: 'object', properties: {
          startSeconds: { type: 'number', minimum: 0 },
          endSeconds: { type: 'number', exclusiveMinimum: 0 },
        }, required: ['startSeconds', 'endSeconds'], additionalProperties: false,
        description: '视频或动画读取的时间区间，单位为秒',
      },
      maxFrames: { type: 'integer', minimum: 1, maximum: 8, description: '视频或动画最多抽取的画面数量，默认 4' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const inputPath = String(args.path ?? '');
    const path = await resolveToolPath(inputPath, ctx, 'read');
    const mode = args.mode;
    if (mode !== undefined && !['text', 'media', 'metadata'].includes(String(mode))) throw new Error(`不支持的 file_read mode：${String(mode)}`);
    const timeRange = args.timeRange as FileReadOptions['timeRange'];
    return readFileContent(path, inputPath, {
      mode: mode as FileReadOptions['mode'],
      pages: args.pages as number[] | undefined,
      timeRange,
      maxFrames: args.maxFrames as number | undefined,
    }, ctx as ToolRunContext | undefined);
  },
};
