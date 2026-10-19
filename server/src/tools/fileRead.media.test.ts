import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { normalizeToolSettings } from '../settings.js';
import { fileReadTool } from './fileRead.js';
import type { ToolResult } from './types.js';
import { appendImageAttachmentTokens, hydrateImageAttachments } from '../llm/attachments.js';
import { ImageInputRejectedError } from '../llm/imageInput.js';

const execFileAsync = promisify(execFile);
const scope = { tenantId: 'tenant_media_test', userId: 'user_media_test' };
let root = '';
const context = () => ({ scope, settings: normalizeToolSettings({ workspaceRoot: root }), threadId: 'thread_media_test' });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'runforge-media-read-'));
  await mkdir(join(root, 'work'), { recursive: true });
});

after(async () => rm(root, { recursive: true, force: true }));

function makePdf(text: string): Buffer {
  const stream = `BT /F1 16 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body);
}

test('file_read extracts PDF text without rendering images in text mode', async () => {
  const path = join(root, 'work', 'report.pdf');
  await writeFile(path, makePdf('RunForge PDF page'));
  const result = await fileReadTool.run({ path, mode: 'text' }, context()) as ToolResult;
  assert.match(result.text, /RunForge PDF page/);
  assert.equal(result.contentParts, undefined);
});

test('file_read renders requested PDF pages to controlled workspace paths in media mode', async () => {
  const path = join(root, 'work', 'report.pdf');
  const result = await fileReadTool.run({ path, mode: 'media', pages: [1] }, context()) as ToolResult;
  assert.match(result.text, /RunForge PDF page/);
  assert.equal(result.contentParts?.length, 1);
  const image = result.contentParts?.[0];
  assert.equal(image?.type, 'image');
  if (image?.type !== 'image') throw new Error('PDF 页面没有生成图片');
  assert.equal(image.path.startsWith('.runforge/media-read/'), true);
  assert.ok((await stat(join(root, image.path))).size > 0);
});

test('file_read detects and converts an extensionless AVIF image to a controlled PNG path', async () => {
  const path = join(root, 'work', 'static');
  await sharp({ create: { width: 4, height: 3, channels: 3, background: '#2450aa' } }).avif().toFile(path);
  const result = await fileReadTool.run({ path }, context()) as ToolResult;
  assert.equal(result.contentParts?.[0]?.type, 'image');
  assert.equal(result.contentParts?.[0]?.mimeType, 'image/png');
  assert.ok((await stat(join(root, result.contentParts![0]!.path))).size > 0);
  const textResult = await fileReadTool.run({ path, mode: 'text' }, context()) as ToolResult;
  assert.equal(textResult.contentParts, undefined);
  assert.match(textResult.text, /不包含画面像素内容/);
});

test('file_read 本地拒绝生产尺寸长图，用户裁剪后的 JPEG 和 PNG 仍能形成多模态输入', async () => {
  const path = join(root, 'work', 'long-screenshot.jpg');
  const original = await sharp({ create: { width: 1027, height: 15000, channels: 3, background: '#2450aa' } }).jpeg().toBuffer();
  await writeFile(path, original);
  await assert.rejects(fileReadTool.run({ path }, context()), (error: unknown) => {
    assert.ok(error instanceof ImageInputRejectedError);
    assert.match(error.message, /1027×15000/);
    assert.match(error.message, /8000/);
    assert.match(error.message, /24000000/);
    assert.match(error.message, /裁剪或缩放.*长截图.*优先分段裁剪.*字迹清晰/);
    assert.doesNotMatch(error.message, /已读取|已交给视觉/);
    return true;
  });

  for (const format of ['jpeg', 'png'] as const) {
    // 模拟用户按提示保留清晰字迹并裁剪；读取工具本身绝不修改原图。
    const croppedPath = join(root, 'work', `cropped.${format}`);
    const cropped = await sharp(original).extract({ left: 0, top: 0, width: 1027, height: 1500 })
      .toFormat(format).toBuffer();
    await writeFile(croppedPath, cropped);
    const result = await fileReadTool.run({ path: croppedPath }, context()) as ToolResult;
    assert.equal(result.contentParts?.length, 1);
    assert.equal(result.contentParts?.[0]?.type, 'image');
    const image = result.contentParts![0]!;
    if (image.type !== 'image') throw new Error('裁剪图片没有进入多模态结果');
    assert.equal(image.data, cropped.toString('base64'));
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [
        { id: `read_${format}`, name: 'file_read', arguments: JSON.stringify({ path: croppedPath }) },
      ] },
      { role: 'tool', toolCallId: `read_${format}`, content: appendImageAttachmentTokens(result.text, result.contentParts, `read_${format}`) },
    ], root);
    assert.deepEqual(hydrated.map((message) => message.role), ['assistant', 'tool', 'user']);
    const hydratedImage = hydrated[2]?.contentParts?.[0];
    assert.equal(hydratedImage?.type, 'image');
    if (hydratedImage?.type !== 'image') throw new Error('裁剪图片没有恢复为多模态输入');
    assert.equal(hydratedImage.mimeType, `image/${format}`);
    assert.equal(hydratedImage.data, cropped.toString('base64'));
  }
});

test('file_read 在转换前明确拒绝像素超限图片，实际宽高不被 sharp 默认限制吞掉', async () => {
  const path = join(root, 'work', 'pixel-limit.svg');
  for (const [width, height] of [[6000, 4001], [30000, 30000]]) {
    await writeFile(path, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1" height="1"/></svg>`);
    await assert.rejects(fileReadTool.run({ path }, context()), new RegExp(`${width}×${height}.*24000000.*裁剪或缩放`));
  }
});

test('file_read extracts timestamped video frames with ffmpeg', async () => {
  const path = join(root, 'work', 'sample');
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-f', 'mp4', '-y', path]);
  const keys = ['RUNFORGE_TRANSCRIPTION_BASE_URL', 'RUNFORGE_TRANSCRIPTION_MODEL'] as const;
  const old = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
  const result = await fileReadTool.run({ path, maxFrames: 2 }, context()) as ToolResult;
  assert.match(result.text, /实际抽取画面：.*秒/);
  assert.match(result.text, /音轨未读取/);
  assert.match(result.text, /未能转写音轨/);
  assert.equal(result.contentParts?.length, 2);
  for (const image of result.contentParts ?? []) {
    if (image.type !== 'image') throw new Error('视频关键帧不是图片');
    assert.match(image.name ?? '', /秒/);
    assert.ok((await stat(join(root, image.path))).size > 0);
  }
  } finally {
    keys.forEach((key, index) => old[index] === undefined ? delete process.env[key] : process.env[key] = old[index]!);
  }
});

test('file_read routes animated GIF through timestamped frame extraction', async () => {
  const path = join(root, 'work', 'animated.gif');
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=4:duration=2', '-loop', '0', '-y', path]);
  const result = await fileReadTool.run({ path, maxFrames: 2 }, context()) as ToolResult;
  assert.match(result.text, /实际抽取画面：.*秒/);
  assert.equal(result.contentParts?.length, 2);
});

test('file_read routes animated WebP through timestamped frame extraction', async () => {
  const gifPath = join(root, 'work', 'animated.gif');
  const path = join(root, 'work', 'animated.webp');
  await sharp(gifPath, { animated: true }).webp({ loop: 0 }).toFile(path);
  const result = await fileReadTool.run({ path, maxFrames: 2 }, context()) as ToolResult;
  assert.match(result.text, /实际抽取画面：.*秒/);
  assert.equal(result.contentParts?.length, 2);
});

test('file_read requires explicit transcription service settings for audio', async () => {
  const keys = ['RUNFORGE_TRANSCRIPTION_BASE_URL', 'RUNFORGE_TRANSCRIPTION_MODEL'] as const;
  const old = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    const path = join(root, 'work', 'no-transcription.wav');
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-y', path]);
    await assert.rejects(fileReadTool.run({ path }, context()), /RUNFORGE_TRANSCRIPTION_BASE_URL/);
  } finally {
    keys.forEach((key, index) => old[index] === undefined ? delete process.env[key] : process.env[key] = old[index]!);
  }
});
