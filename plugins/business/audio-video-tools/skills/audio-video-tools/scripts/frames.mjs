import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('通用音视频插件只支持 Linux amd64');
}
const [source, target, timesArgument] = process.argv.slice(2);
if (!source || !target) throw new Error('用法: frames.mjs <视频路径> <输出目录> [关键帧秒数CSV]');
const input = resolve(source);
const output = resolve(target);
await mkdir(output, { recursive: true });
const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=noprint_wrappers=1:nokey=1', input]);
const duration = Number(stdout.trim());
if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取媒体时长');
const count = Math.min(12, Math.max(3, Math.ceil(duration / 90)), Math.max(1, Math.floor(duration)));
const timestamps = timesArgument
  ? timesArgument.split(',').map((value) => Number(value))
  : Array.from({ length: count }, (_, index) => Number((duration * (index + 0.5) / count).toFixed(2)));
if (timestamps.some((seconds) => !Number.isFinite(seconds) || seconds < 0 || seconds >= duration)) {
  throw new Error('关键帧秒数必须在视频时长内');
}
const frames = [];
for (const [index, seconds] of timestamps.entries()) {
  const image = join(output, `${String(index + 1).padStart(2, '0')}-${seconds}s.jpg`);
  await new Promise((accept, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', input,
      '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', '-y', image], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? accept() : reject(new Error(`ffmpeg 退出码 ${code}`)));
  });
  frames.push({ seconds, image });
}
const manifest = join(output, 'frames.json');
await writeFile(manifest, JSON.stringify({ video: input, frames }, null, 2));
console.log(manifest);
