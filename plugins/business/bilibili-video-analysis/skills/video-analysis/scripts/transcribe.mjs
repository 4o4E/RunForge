import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('用法: transcribe.mjs <音轨路径> <输出.srt>');
const compressed = `${resolve(destination)}.mp3`;
await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', resolve(source),
  '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', '-y', compressed]);
const { RunForgeWorkloadClient } = await import(process.env.RUNFORGE_WORKLOAD_SDK);
const client = new RunForgeWorkloadClient();
const baseUrl = (await client.secrets.get('bilibili-video-analysis.speaches-url')).replace(/\/+$/, '');
const key = await client.secrets.get('bilibili-video-analysis.speaches-key');
const form = new FormData();
form.set('file', new Blob([await readFile(compressed)]), basename(compressed));
form.set('model', 'deepdml/faster-whisper-large-v3-turbo-ct2');
form.set('language', 'zh');
form.set('response_format', 'srt');
form.append('timestamp_granularities[]', 'segment');
const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
});
if (!response.ok) throw new Error(`Speaches HTTP ${response.status}: ${await response.text()}`);
const srt = await response.text();
await writeFile(resolve(destination), srt);
console.log(resolve(destination));
if (!srt.trim()) console.log('转写为空：没有有效讲话，立即返回 skipped；不要下载画面或搜索');
