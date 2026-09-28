import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('视频分析插件只支持 Linux amd64');
}
const [operation, input, target] = process.argv.slice(2);
if (!['metadata', 'comments', 'audio', 'video'].includes(operation) || !input || !target) {
  throw new Error('用法: video.mjs metadata|comments|audio|video <B站视频URL> <工作目录>');
}
const output = resolve(target);
const execFileAsync = promisify(execFile);
await mkdir(output, { recursive: true });

async function run(program, args) {
  await new Promise((accept, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? accept() : reject(new Error(`${program} 退出码 ${code}`)));
  });
}

async function videoUrl(raw) {
  const url = new URL(raw);
  const resolved = url.hostname === 'b23.tv' ? new URL((await fetch(url)).url) : url;
  if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(resolved.hostname)) {
    throw new Error('当前插件只支持 B 站视频 URL');
  }
  const bvid = /^\/video\/(BV[A-Za-z0-9]+)/.exec(resolved.pathname)?.[1];
  if (!bvid) throw new Error('URL 缺少 BV 号');
  const page = Number(resolved.searchParams.get('p') || '1');
  if (!Number.isInteger(page) || page < 1) throw new Error('分 P 参数无效');
  return { bvid, page, url: `https://www.bilibili.com/video/${bvid}?p=${page}` };
}

async function apiJson(url) {
  const response = await fetch(url, { headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`B 站接口 HTTP ${response.status}: ${url}`);
  const body = await response.json();
  if (body.code !== 0) throw new Error(`B 站接口错误 ${body.code}: ${body.message}`);
  return body.data;
}

const video = await videoUrl(input);
if (operation === 'comments' || operation === 'video') {
  // 分档必须发生在转写之后；评论允许配合空转写判断，画面只供详细分析使用。
  const transcripts = (await readdir(output)).filter((name) =>
    name.startsWith(`${video.bvid}-p${video.page}`) && name.endsWith('.srt'));
  if (transcripts.length !== 1) throw new Error('先完成实际音轨转写，再决定是否读取评论或关键帧');
  if (operation === 'video') {
    const transcript = await readFile(join(output, transcripts[0]), 'utf8');
    if (!transcript.trim()) throw new Error('转写为空、没有有效讲话；不能进入需要画面的详细分析');
  }
}
if (operation === 'metadata') {
  const data = await apiJson(`https://api.bilibili.com/x/web-interface/view?bvid=${video.bvid}`);
  const part = data.pages?.[video.page - 1];
  if (!part) throw new Error(`视频不存在第 ${video.page} 分 P`);
  let category = String(data.tname_v2 || data.tname || '').trim();
  if (!category && data.tid) {
    const related = await apiJson(`https://api.bilibili.com/x/web-interface/archive/related?bvid=${video.bvid}`);
    category = (Array.isArray(related) ? related : [])
      .find((entry) => Number(entry?.tid) === Number(data.tid) && String(entry?.tname || '').trim())
      ?.tname?.trim() || '';
  }
  const result = {
    url: video.url, bvid: video.bvid, aid: data.aid, cid: part.cid, page: video.page,
    title: data.title, partTitle: part.part, description: data.desc, category,
    durationSeconds: part.duration, author: data.owner?.name,
  };
  const metadataFile = join(output, `${video.bvid}-p${video.page}-metadata.json`);
  await writeFile(metadataFile, JSON.stringify(result, null, 2));
  console.log(metadataFile);
} else if (operation === 'comments') {
  const data = await apiJson(`https://api.bilibili.com/x/web-interface/view?bvid=${video.bvid}`);
  const comments = await apiJson(`https://api.bilibili.com/x/v2/reply/main?oid=${data.aid}&type=1&mode=3&next=0`);
  const regular = Array.isArray(comments.replies) ? comments.replies : [];
  const pinned = [comments.upper?.top, ...(Array.isArray(comments.top_replies) ? comments.top_replies : [])]
    .filter((entry) => entry && typeof entry === 'object');
  const pinnedIds = new Set([...pinned, ...regular.filter((entry) => entry.reply_control?.is_up_top)]
    .map((entry) => String(entry.rpid)));
  const selected = [...pinned, ...regular]
    .filter((entry, index, all) => all.findIndex((candidate) => String(candidate.rpid) === String(entry.rpid)) === index)
    .sort((left, right) => Number(pinnedIds.has(String(right.rpid))) - Number(pinnedIds.has(String(left.rpid))) ||
      Number(right.like || 0) - Number(left.like || 0))
    .slice(0, 20);
  const result = {
    bvid: video.bvid, page: video.page,
    comments: selected.map((entry) => ({
      id: entry.rpid,
      pinned: pinnedIds.has(String(entry.rpid)) || Boolean(entry.reply_control?.is_up_top),
      likes: entry.like,
      author: entry.member?.uname,
      authorIsUploader: String(entry.member?.mid || '') === String(data.owner?.mid || ''),
      text: entry.content?.message,
    })),
  };
  const file = join(output, `${video.bvid}-p${video.page}-comments.json`);
  await writeFile(file, JSON.stringify(result, null, 2));
  console.log(file);
} else {
  const bbdown = 'bbdown';
  const mediaDir = join(output, operation, `${video.bvid}-p${video.page}`);
  await mkdir(mediaDir, { recursive: true });
  // 默认强制替换媒体 CDN 的 host 会让部分公开画面流返回 404；保留播放接口给出的原始地址。
  const args = [video.url, '--hide-streams', '--skip-cover', '--skip-subtitle', '--skip-ai',
    '--force-replace-host', 'false',
    '--work-dir', mediaDir, '--select-page', String(video.page)];
  if (operation === 'audio') args.push('--audio-only', '--skip-mux');
  else args.push('--ffmpeg-path', 'ffmpeg', '--dfn-priority', '64,32,16');
  await run(bbdown, args);
  async function findMedia(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await findMedia(path));
      else if ((operation === 'audio' ? /\.(m4a|aac|flac|mp3|opus|ogg|wav|webm)$/i : /\.(mp4|mkv|flv|ts|webm)$/i).test(entry.name)) files.push(path);
    }
    return files;
  }
  const media = await findMedia(mediaDir);
  if (media.length !== 1) throw new Error(`期望一个${operation}文件，实际找到 ${media.length} 个`);
  const mediaFile = media[0];
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', mediaFile]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取媒体时长');
  const detail = await apiJson(`https://api.bilibili.com/x/web-interface/view?bvid=${video.bvid}`);
  const expected = detail.pages?.[video.page - 1]?.duration;
  if (!expected) throw new Error(`视频不存在第 ${video.page} 分 P`);
  if (duration < expected - Math.max(3, expected * 0.02)) {
    throw new Error(`下载内容不完整：实际 ${duration.toFixed(1)} 秒，视频分 P 为 ${expected} 秒`);
  }
  console.log(mediaFile);
}
