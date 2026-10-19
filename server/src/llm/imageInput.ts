import sharp, { type Metadata } from 'sharp';
import { fileTypeFromBuffer } from 'file-type';

const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_IMAGE_EDGE = 8000;
export const MAX_MODEL_IMAGE_PIXELS = 24_000_000;

export interface PreparedImage {
  bytes: Buffer;
  mimeType: string;
}

export class ImageInputRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInputRejectedError';
  }
}

/** 只检查头部尺寸，不解码像素；拒绝时保留原图，调用方明确裁剪或缩放副本后重新读取。 */
export function assertModelImageDimensions(width: number | undefined, height: number | undefined): void {
  if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new ImageInputRejectedError('无法读取图片实际宽高，请提供有效图片');
  }
  const pixels = width * height;
  if (width > MAX_MODEL_IMAGE_EDGE || height > MAX_MODEL_IMAGE_EDGE || pixels > MAX_MODEL_IMAGE_PIXELS) {
    throw new ImageInputRejectedError(
      `图片实际尺寸为 ${width}×${height} 像素（${pixels} 像素），超过本地模型输入限制：任一边不得超过 ${MAX_MODEL_IMAGE_EDGE} 像素，`
      + `总像素不得超过 ${MAX_MODEL_IMAGE_PIXELS}（2400 万）。请裁剪或缩放后重新读取；长截图请优先分段裁剪，保留字迹清晰。不会自动缩小或丢弃内容。`,
    );
  }
}

/** 以真实内容判定图片格式；只有受支持的静态图像才交给对话模型。 */
export async function prepareModelImage(bytes: Buffer, declaredMimeType: string): Promise<PreparedImage | null> {
  const detected = await fileTypeFromBuffer(bytes);
  const candidate = detected?.mime ?? declaredMimeType;
  if (!candidate.startsWith('image/')) return null;

  let metadata: Metadata;
  try {
    // 仅解析头部时关闭 sharp 的像素拒绝，先取得真实尺寸，再在任何解码或转换前自行检查。
    metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    throw new ImageInputRejectedError('图片内容损坏或无法解码');
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new ImageInputRejectedError('动态图像需要通过 file_read 按时间读取画面');
  }
  assertModelImageDimensions(metadata.width, metadata.height);

  let output = bytes;
  let mimeType = detected?.mime ?? candidate;
  // 其他静态图像统一转换为 PNG，避免把 SVG、BMP、AVIF 等格式直接交给不支持的模型。
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    try {
      output = await sharp(bytes, { limitInputPixels: MAX_MODEL_IMAGE_PIXELS }).rotate().png().toBuffer();
    } catch {
      throw new ImageInputRejectedError('图片内容无法转换为模型支持的格式');
    }
    mimeType = 'image/png';
  }
  if (output.length > MAX_MODEL_IMAGE_BYTES) {
    throw new ImageInputRejectedError(`图片为 ${output.length} 字节，超过模型输入上限 ${MAX_MODEL_IMAGE_BYTES} 字节（10 MiB）。请裁剪或缩放后重新读取；长截图优先分段裁剪，保留字迹清晰`);
  }
  return { bytes: output, mimeType };
}
