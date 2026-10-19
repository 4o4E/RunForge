import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ImageInputRejectedError, prepareModelImage } from './imageInput.js';

test('发送前按实际内容识别并转换静态图片', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  const converted = await prepareModelImage(svg, 'image/svg+xml');
  assert.equal(converted?.mimeType, 'image/png');
  assert.equal((await sharp(converted!.bytes).metadata()).format, 'png');
});

test('发送前拒绝损坏图片和动态图像', async () => {
  await assert.rejects(prepareModelImage(Buffer.from('invalid'), 'image/png'), ImageInputRejectedError);
  const frames = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
  const animated = await sharp(frames, { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } })
    .gif({ loop: 0 }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(prepareModelImage(animated, 'image/gif'), ImageInputRejectedError);
});

test('普通 JPEG 和 PNG 保留原始字节，不解码转换或自动缩放', async () => {
  for (const format of ['jpeg', 'png'] as const) {
    const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#2450aa' } })
      .toFormat(format).toBuffer();
    const prepared = await prepareModelImage(bytes, 'image/png');
    assert.equal(prepared?.mimeType, `image/${format}`);
    assert.equal(prepared?.bytes, bytes);
  }
});

test('尺寸拒绝保留真实宽高，并同时给出边长、像素限制和长截图处理方向', async () => {
  for (const [width, height] of [[1027, 15000], [6000, 4001], [30000, 30000]]) {
    // SVG 只需读取尺寸头部；最后一例超过 sharp 默认像素上限，不能先被泛化为解码错误。
    const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1" height="1"/></svg>`);
    await assert.rejects(prepareModelImage(bytes, 'image/svg+xml'), (error: unknown) => {
      assert.ok(error instanceof ImageInputRejectedError);
      assert.match(error.message, new RegExp(`${width}×${height}`));
      assert.match(error.message, /8000/);
      assert.match(error.message, /24000000/);
      assert.match(error.message, /裁剪或缩放/);
      assert.match(error.message, /长截图.*优先分段裁剪.*字迹清晰/);
      return true;
    });
  }
});

test('边长恰好达到限制的静态图片仍可进入模型', async () => {
  const bytes = await sharp({ create: { width: 8000, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal((await prepareModelImage(bytes, 'image/png'))?.bytes, bytes);
});
