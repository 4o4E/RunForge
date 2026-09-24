import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LlmContentPart } from '../../llm/types.js';
import type { ToolRunContext } from '../types.js';
import { MAX_AUDIO_SECONDS, transcribeAudio } from './audio.js';
import { MAX_MEDIA_FILE_BYTES, MAX_VIDEO_FRAMES, prepareOutputRoot, saveDerivedImage, throwIfAborted } from './shared.js';

const execFileAsync = promisify(execFile);
const MEDIA_TIMEOUT_MS = 10 * 60_000;
interface Probe { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> }

async function runMediaCommand(binary: string, args: string[], ctx?: ToolRunContext): Promise<string> {
  throwIfAborted(ctx);
  try {
    const result = await execFileAsync(binary, args, {
      timeout: MEDIA_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal: ctx?.abortSignal,
    });
    return result.stdout;
  } catch (error) {
    if (ctx?.abortSignal?.aborted) throw ctx.abortSignal.reason;
    const detail = (error as { stderr?: string }).stderr?.trim().slice(0, 500);
    throw new Error(`${binary} 执行失败：${detail || (error as Error).message}`);
  }
}

export async function probeMedia(path: string, ctx?: ToolRunContext): Promise<Probe> {
  const raw = await runMediaCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', path], ctx);
  return JSON.parse(raw) as Probe;
}

export async function readVideo(
  path: string,
  options: { mode: string; timeRange?: { startSeconds: number; endSeconds: number }; maxFrames?: number },
  ctx?: ToolRunContext,
): Promise<{ text: string; contentParts?: LlmContentPart[] }> {
  const info = await stat(path);
  if (info.size > MAX_MEDIA_FILE_BYTES) throw new Error(`视频超过 ${MAX_MEDIA_FILE_BYTES} 字节读取上限`);
  const probe = await probeMedia(path, ctx);
  const duration = Number(probe.format?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
  const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
  if (!videoStream) throw new Error('文件没有视频画面轨道');
  if (options.mode === 'metadata') {
    return { text: `视频元信息：时长 ${duration.toFixed(2)} 秒，画面 ${videoStream.width ?? '未知'}×${videoStream.height ?? '未知'}，音轨${probe.streams?.some((stream) => stream.codec_type === 'audio') ? '存在' : '不存在'}。` };
  }

  const start = options.timeRange?.startSeconds ?? 0;
  const end = options.timeRange?.endSeconds ?? duration;
  if (start < 0 || end <= start || end > duration) throw new Error(`视频时间范围必须位于 0 到 ${duration.toFixed(2)} 秒之间`);
  const frameCount = options.maxFrames ?? 4;
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_VIDEO_FRAMES) {
    throw new Error(`一次最多抽取 ${MAX_VIDEO_FRAMES} 张视频画面`);
  }
  const root = await prepareOutputRoot(ctx);
  const interval = (end - start) / (frameCount + 1);
  const timestamps = options.mode === 'text' ? [] : Array.from({ length: frameCount }, (_, index) => start + interval * (index + 1));
  const images: LlmContentPart[] = [];
  for (const timestamp of timestamps) {
    throwIfAborted(ctx);
    const framePath = join(root, `frame-${randomUUID()}.png`);
    let image: Extract<LlmContentPart, { type: 'image' }>;
    try {
      await runMediaCommand('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-ss', timestamp.toFixed(3), '-i', path,
        '-frames:v', '1', '-vf', 'scale=min(1440\\,iw):-2', '-y', framePath,
      ], ctx);
      image = await saveDerivedImage(await readFile(framePath), `${path}-${timestamp.toFixed(2)}s`, ctx);
    } finally {
      await rm(framePath, { force: true });
    }
    image.name = `${timestamp.toFixed(2)} 秒`;
    images.push(image);
  }

  let audioText = '未尝试转写';
  if (probe.streams?.some((stream) => stream.codec_type === 'audio')) {
    if (end - start > MAX_AUDIO_SECONDS) {
      audioText = `音轨未读取：所选范围超过 ${MAX_AUDIO_SECONDS / 3600} 小时转写上限`;
    } else {
      const audioPath = join(root, `audio-${randomUUID()}.mp3`);
      try {
        await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-t', (end - start).toFixed(3), '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', '-y', audioPath], ctx);
        audioText = await transcribeAudio(audioPath, ctx, start);
      } catch (error) {
        if (ctx?.abortSignal?.aborted) throw ctx.abortSignal.reason;
        audioText = `未能转写音轨：${(error as Error).message}`;
      } finally {
        await rm(audioPath, { force: true });
      }
    }
  } else {
    audioText = '该视频没有音轨';
  }
  const frameSummary = timestamps.map((timestamp) => `${timestamp.toFixed(2)} 秒`).join('、');
  const completeness = audioText.startsWith('未能转写音轨') || audioText.startsWith('音轨未读取')
    ? '画面已读取抽样关键帧，但音轨未读取，无法据此代表完整视频。'
    : '画面只读取了抽样关键帧；语音转写不能完整识别音乐和环境声音。';
  return {
    text: `视频总时长 ${duration.toFixed(2)} 秒。本次实际抽取画面：${frameSummary || '未抽取画面'}。${completeness}\n音轨状态：\n${audioText}`,
    ...(images.length ? { contentParts: images } : {}),
  };
}
