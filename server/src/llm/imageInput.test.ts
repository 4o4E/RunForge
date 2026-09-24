import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ImageInputRejectedError, prepareModelImage } from './imageInput.js';

test('发送前按实际内容识别并转换静态图片', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  const converted = await prepareModelImage(svg, 'image/svg+xml');
  assert.equal(converted?.mimeType, 'image/png');
  assert.equal((await sharp(Buffer.from(converted!.data, 'base64')).metadata()).format, 'png');
});

test('发送前拒绝损坏图片和动态图像', async () => {
  await assert.rejects(prepareModelImage(Buffer.from('invalid'), 'image/png'), ImageInputRejectedError);
  const frames = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
  const animated = await sharp(frames, { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } })
    .gif({ loop: 0 }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(prepareModelImage(animated, 'image/gif'), ImageInputRejectedError);
});
