import sharp, { type Metadata } from 'sharp';
import { fileTypeFromBuffer } from 'file-type';

const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;

export interface PreparedImage {
  data: string;
  mimeType: string;
}

export class ImageInputRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInputRejectedError';
  }
}

/** 以真实内容判定图片格式；只有受支持的静态图像才交给对话模型。 */
export async function prepareModelImage(bytes: Buffer, declaredMimeType: string): Promise<PreparedImage | null> {
  const detected = await fileTypeFromBuffer(bytes);
  const candidate = detected?.mime ?? declaredMimeType;
  if (!candidate.startsWith('image/')) return null;

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata();
  } catch {
    throw new ImageInputRejectedError('图片内容损坏或无法解码');
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new ImageInputRejectedError('动态图像需要通过 file_read 按时间读取画面');
  }

  let output = bytes;
  let mimeType = detected?.mime ?? candidate;
  // 其他静态图像统一转换为 PNG，避免把 SVG、BMP、AVIF 等格式直接交给不支持的模型。
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    try {
      output = await sharp(bytes, { limitInputPixels: 24_000_000 }).png().toBuffer();
    } catch {
      throw new ImageInputRejectedError('图片内容无法转换为模型支持的格式');
    }
    mimeType = 'image/png';
  }
  if (output.length > MAX_MODEL_IMAGE_BYTES) {
    throw new ImageInputRejectedError(`图片超过模型输入上限 ${MAX_MODEL_IMAGE_BYTES} 字节`);
  }
  return { data: output.toString('base64'), mimeType };
}
