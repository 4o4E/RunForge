const DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MEDIA_TYPE_RE = /^(?:image|audio|video|application\/(?:pdf|octet-stream)|multipart\/)/i;
const MEDIA_KIND_RE = /^(?:image|input_image|output_image|audio|input_audio|output_audio|video|input_video|file|input_file|document|base64)$/i;
const INLINE_DATA_URL_RE = /data:([^;,\s"']+)(?:;[^,\s"']*)?;base64,([A-Za-z0-9+/]*={0,2})/gi;

function byteLength(base64: string): number {
  return Math.max(0, Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0));
}

function omitted(mimeType: string | null, size: number): string {
  return `[媒体二进制已省略${mimeType ? `；类型=${mimeType}` : ''}；字节数=${size}]`;
}

function mimeFromObject(value: Record<string, unknown>): string | null {
  for (const key of ['media_type', 'mime_type', 'mimeType', 'content_type', 'contentType']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && MEDIA_TYPE_RE.test(candidate)) return candidate;
  }
  return null;
}

/** 观测记录保留消息结构和文本，只把媒体字节替换成类型与大小摘要。 */
export function sanitizeMediaPayloads(value: unknown): unknown {
  const visit = (current: unknown, mediaContext: boolean, mimeType: string | null, field = ''): unknown => {
    if (typeof current === 'string') {
      const dataUrl = DATA_URL_RE.exec(current);
      if (dataUrl) return omitted(dataUrl[1] || mimeType, byteLength(dataUrl[2]));
      if (mediaContext && /^(?:data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)$/i.test(field)
        && current.length >= 64 && BASE64_RE.test(current)) {
        return omitted(mimeType, byteLength(current));
      }
      const inlineSafe = current.replace(INLINE_DATA_URL_RE, (_match, mime: string, data: string) => omitted(mime, byteLength(data)));
      const lines = inlineSafe.split(/(?<=\n)/);
      let parsedAny = false;
      const sanitizedLines = lines.map((line) => {
        const match = /^(\s*data:\s*)(\{.*\}|\[.*\])(\r?\n)?$/s.exec(line);
        if (!match) return line;
        try {
          const parsed: unknown = JSON.parse(match[2]);
          parsedAny = true;
          return `${match[1]}${JSON.stringify(visit(parsed, mediaContext, mimeType))}${match[3] ?? ''}`;
        } catch {
          return line;
        }
      });
      if (parsedAny) return sanitizedLines.join('');
      try {
        const parsed: unknown = JSON.parse(inlineSafe);
        if (parsed && typeof parsed === 'object') return JSON.stringify(visit(parsed, mediaContext, mimeType));
      } catch {
        // 普通文本保持原样。
      }
      return inlineSafe;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, mediaContext, mimeType));
    if (!current || typeof current !== 'object') return current;

    const row = current as Record<string, unknown>;
    const ownMime = mimeFromObject(row) ?? mimeType;
    const type = typeof row.type === 'string' ? row.type : '';
    const isMedia = mediaContext || Boolean(ownMime) || MEDIA_KIND_RE.test(type)
      || /^(?:image|audio|video|file|document|inline_data|input_image|input_audio|input_video)$/i.test(field);
    return Object.fromEntries(Object.entries(row).map(([key, child]) => [
      key,
      visit(child, isMedia, ownMime, key),
    ]));
  };
  return visit(value, false, null);
}
