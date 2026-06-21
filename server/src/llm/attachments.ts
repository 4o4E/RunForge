import { readFile, stat } from 'node:fs/promises';
import type { LlmContentPart, LlmMessage } from './types.js';
import { isImageMediaType, mediaTypeFromPath, normalizeRemotePath, toRemotePath } from '../files/workspace.js';

const FILE_TOKEN_RE = /\[\[file:({.*?})\]\]/g;
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface FileToken {
  raw: string;
  path: string;
  name?: string;
  kind?: string;
}

function parseFileTokens(text: string): FileToken[] {
  const tokens: FileToken[] = [];
  for (const match of text.matchAll(FILE_TOKEN_RE)) {
    try {
      const parsed = JSON.parse(match[1]) as { path?: unknown; name?: unknown; kind?: unknown };
      if (typeof parsed.path !== 'string' || !parsed.path.trim()) continue;
      tokens.push({
        raw: match[0],
        path: parsed.path,
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
      });
    } catch {
      // 附件 token 是前端生成的内部标记；解析失败时保留原文，避免误删用户输入。
    }
  }
  return tokens;
}

function cleanAttachmentText(text: string, images: LlmContentPart[]): string {
  let cleaned = text.replace(FILE_TOKEN_RE, '').trim();
  if (!images.length) return cleaned;
  const lines = images.map((part) => {
    if (part.type !== 'image') return '';
    return `- ${part.name ?? part.path} (${part.path}, ${part.mimeType})`;
  }).filter(Boolean);
  const suffix = `用户已上传图片：\n${lines.join('\n')}`;
  cleaned = cleaned ? `${cleaned}\n\n${suffix}` : suffix;
  return cleaned;
}

async function loadImageToken(token: FileToken, workspaceRoot: string): Promise<LlmContentPart | null> {
  const absolute = normalizeRemotePath(token.path, workspaceRoot);
  const mediaType = mediaTypeFromPath(absolute);
  if (!isImageMediaType(mediaType)) return null;

  const info = await stat(absolute);
  if (!info.isFile()) return null;
  if (info.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(`图片附件超过 ${MAX_IMAGE_ATTACHMENT_BYTES} 字节上限：${token.path}`);
  }

  const data = await readFile(absolute);
  return {
    type: 'image',
    data: data.toString('base64'),
    mimeType: mediaType,
    path: toRemotePath(absolute, workspaceRoot),
    name: token.name,
  };
}

export async function hydrateImageAttachments(messages: LlmMessage[], workspaceRoot: string): Promise<LlmMessage[]> {
  const hydrated: LlmMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || !message.content) {
      hydrated.push(message);
      continue;
    }

    const tokens = parseFileTokens(message.content);
    if (!tokens.length) {
      hydrated.push(message);
      continue;
    }

    const imageParts: LlmContentPart[] = [];
    for (const token of tokens) {
      const part = await loadImageToken(token, workspaceRoot);
      if (part) imageParts.push(part);
    }

    if (!imageParts.length) {
      hydrated.push(message);
      continue;
    }

    const text = cleanAttachmentText(message.content, imageParts);
    hydrated.push({
      ...message,
      contentParts: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...imageParts,
      ],
    });
  }
  return hydrated;
}
