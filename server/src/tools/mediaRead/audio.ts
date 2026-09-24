import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ToolRunContext } from '../types.js';
import { readAuditedWorkloadSecrets } from '../../businessPlugins/secretService.js';
import { MAX_MEDIA_FILE_BYTES, prepareOutputRoot, throwIfAborted } from './shared.js';

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPTION_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 6 * 60 * 60;
const CHUNK_SECONDS = 10 * 60;
const CHUNK_OVERLAP_SECONDS = 2;
const TRANSCRIPTION_TIMEOUT_MS = 10 * 60_000;

function transcriptionEndpoint(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  if (root.endsWith('/audio/transcriptions')) return root;
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/audio/transcriptions`;
}

async function transcriptionSettings(ctx?: ToolRunContext): Promise<{ endpoint: string; apiKey: string; model: string; language: string }> {
  // 已选中的通用音视频插件沿用租户配置与 Secret 审计，不要求管理员重复配置转写服务。
  if (ctx?.pluginRoots?.some((root) => basename(root) === 'audio-video-tools')) {
    const token = ctx.env?.WORKLOAD_TOKEN;
    if (!token) throw new Error('audio-video-tools 转写需要当前运行的 WORKLOAD_TOKEN');
    const secrets = await readAuditedWorkloadSecrets(token, 'backend', ctx.stepId, [
      'audio-video-tools.speaches-url', 'audio-video-tools.speaches-key',
    ]);
    const baseUrl = secrets['audio-video-tools.speaches-url'];
    const apiKey = secrets['audio-video-tools.speaches-key'];
    if (!baseUrl || !apiKey) throw new Error('audio-video-tools 尚未配置 Speaches 地址或密钥');
    return {
      endpoint: transcriptionEndpoint(baseUrl),
      apiKey,
      model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
      language: process.env.RUNFORGE_TRANSCRIPTION_LANGUAGE?.trim() ?? 'zh',
    };
  }
  const baseUrl = process.env.RUNFORGE_TRANSCRIPTION_BASE_URL?.trim().replace(/\/+$/, '');
  const model = process.env.RUNFORGE_TRANSCRIPTION_MODEL?.trim();
  if (!baseUrl || !model) {
    throw new Error('音频转写尚未配置；请设置 RUNFORGE_TRANSCRIPTION_BASE_URL 与 RUNFORGE_TRANSCRIPTION_MODEL');
  }
  return {
    endpoint: transcriptionEndpoint(baseUrl),
    apiKey: process.env.RUNFORGE_TRANSCRIPTION_API_KEY ?? '',
    model,
    language: process.env.RUNFORGE_TRANSCRIPTION_LANGUAGE?.trim() ?? '',
  };
}

/** 转写端点有逐段时间戳时保留；否则用实际音频分段的时间范围标注文字。 */
async function audioDuration(path: string, ctx?: ToolRunContext): Promise<number> {
  throwIfAborted(ctx);
  const result = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], {
    timeout: TRANSCRIPTION_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    signal: ctx?.abortSignal,
  });
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取音频时长');
  if (duration > MAX_AUDIO_SECONDS) throw new Error(`音频超过 ${MAX_AUDIO_SECONDS / 3600} 小时转写上限`);
  return duration;
}

async function transcribeChunk(
  path: string,
  settings: Awaited<ReturnType<typeof transcriptionSettings>>,
  offset: number,
  duration: number,
  ctx?: ToolRunContext,
): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_TRANSCRIPTION_UPLOAD_BYTES) throw new Error(`音频分段超过 ${MAX_TRANSCRIPTION_UPLOAD_BYTES} 字节服务限制`);
  const form = new FormData();
  form.set('file', new Blob([bytes]), basename(path));
  form.set('model', settings.model);
  form.set('response_format', 'json');
  if (settings.language) form.set('language', settings.language);
  const timeout = AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS);
  const signal = ctx?.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout;
  const response = await fetch(settings.endpoint, {
    method: 'POST',
    headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : undefined,
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`音频转写服务返回 ${response.status}：${detail || response.statusText}`);
  }
  const result = await response.json() as {
    text?: unknown;
    segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
  };
  const fullText = typeof result.text === 'string'
    ? result.text
    : (result.segments ?? []).map((segment) => typeof segment.text === 'string' ? segment.text : '').filter(Boolean).join(' ');
  if (!fullText) throw new Error('音频转写服务没有返回文字内容');
  const segments = (result.segments ?? [])
    .filter((segment) => typeof segment.text === 'string')
    .map((segment) => `[${(Number(segment.start ?? 0) + offset).toFixed(2)}–${(Number(segment.end ?? 0) + offset).toFixed(2)} 秒] ${segment.text}`);
  return segments.length
    ? segments.join('\n')
    : `[约 ${offset.toFixed(2)}–${(offset + duration).toFixed(2)} 秒] ${fullText}`;
}

/** OpenAI 兼容上传最多按 25 MiB 控制；长音频转成小体积 MP3 并保留重叠，时间戳映射回原音频。 */
export async function transcribeAudio(path: string, ctx?: ToolRunContext, offsetSeconds = 0): Promise<string> {
  const info = await stat(path);
  if (info.size > MAX_MEDIA_FILE_BYTES) throw new Error(`音频超过 ${MAX_MEDIA_FILE_BYTES} 字节读取上限`);
  const settings = await transcriptionSettings(ctx);
  throwIfAborted(ctx);
  const duration = await audioDuration(path, ctx);
  const chunks: string[] = [];
  if (info.size <= MAX_TRANSCRIPTION_UPLOAD_BYTES && duration <= CHUNK_SECONDS) {
    chunks.push(await transcribeChunk(path, settings, offsetSeconds, duration, ctx));
  } else {
    const workspace = await prepareOutputRoot(ctx);
    const directory = await mkdtemp(join(workspace, 'transcription-'));
    try {
      for (let start = 0; start < duration; start += CHUNK_SECONDS - CHUNK_OVERLAP_SECONDS) {
        throwIfAborted(ctx);
        const segmentDuration = Math.min(CHUNK_SECONDS, duration - start);
        const partPath = join(directory, `part-${chunks.length}.mp3`);
        await execFileAsync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-t', segmentDuration.toFixed(3), '-i', path,
          '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', '-y', partPath,
        ], { timeout: TRANSCRIPTION_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal: ctx?.abortSignal });
        chunks.push(await transcribeChunk(partPath, settings, offsetSeconds + start, segmentDuration, ctx));
        if (start + segmentDuration >= duration) break;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return `语音转写结果（共 ${chunks.length} 段；分段间保留 ${CHUNK_OVERLAP_SECONDS} 秒重叠）：\n${chunks.join('\n')}\n\n这是语音转写，不包含对音乐、环境声或其他非语音声音的完整识别。`;
}
