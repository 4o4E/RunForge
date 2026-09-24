import { readFile, stat } from 'node:fs/promises';
import type { LlmContentPart, LlmMessage } from './types.js';
import { isImageMediaType, mediaTypeFromPath, normalizeRemotePath, toRemotePath } from '../files/workspace.js';
import { resolveWorkspaceFilePath } from '../files/workspace.js';
import { isWithin } from '../tools/policy.js';
import { isAbsolute, resolve } from 'node:path';

const FILE_TOKEN_RE = /\[\[file:({.*?})\]\]/g;
const TOOL_IMAGE_KIND = 'tool-image';
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface FileToken {
  raw: string;
  path: string;
  name?: string;
  kind?: string;
  mimeType?: string;
  callId?: string;
}

/** 将工具生成的图片引用写入持久化文本；不写入 base64，重启后仍可从 workspace 重读。 */
export function appendImageAttachmentTokens(text: string, parts: LlmContentPart[] | undefined, callId: string): string {
  const images = (parts ?? []).filter((part): part is Extract<LlmContentPart, { type: 'image' }> => part.type === 'image');
  if (!images.length) return text;
  const tokens = images.map((part) => `[[file:${JSON.stringify({
    kind: TOOL_IMAGE_KIND,
    callId,
    path: part.path,
    name: part.name,
    mimeType: part.mimeType,
  })}]]`);
  return `${text}\n\n${tokens.join('\n')}`;
}

function parseFileTokens(text: string): FileToken[] {
  const tokens: FileToken[] = [];
  for (const match of text.matchAll(FILE_TOKEN_RE)) {
    try {
      const parsed = JSON.parse(match[1]) as { path?: unknown; name?: unknown; kind?: unknown; mimeType?: unknown; callId?: unknown };
      if (typeof parsed.path !== 'string' || !parsed.path.trim()) continue;
      tokens.push({
        raw: match[0],
        path: parsed.path,
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
        mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : undefined,
        callId: typeof parsed.callId === 'string' ? parsed.callId : undefined,
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

function attachmentPath(path: string, workspaceRoot: string, userFilesRoot?: string): string {
  return userFilesRoot && isAbsolute(path) && isWithin(userFilesRoot, path)
    ? resolve(path)
    : normalizeRemotePath(path, workspaceRoot);
}

async function loadImageToken(token: FileToken, workspaceRoot: string, userFilesRoot?: string): Promise<LlmContentPart | null> {
  const absolute = attachmentPath(token.path, workspaceRoot, userFilesRoot);
  if (userFilesRoot && isWithin(userFilesRoot, absolute)) {
    await resolveWorkspaceFilePath(userFilesRoot, absolute, { access: 'read' });
  }
  const mediaType = token.mimeType?.trim() || mediaTypeFromPath(absolute);
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
    path: userFilesRoot && isWithin(userFilesRoot, absolute) ? absolute : toRemotePath(absolute, workspaceRoot),
    name: token.name,
  };
}

export async function hydrateImageAttachments(messages: LlmMessage[], workspaceRoot: string, userFilesRoot?: string): Promise<LlmMessage[]> {
  // 工具图片只属于最近一轮 tool_call：模型已经消费过的旧帧不重复装载，避免每轮把全部关键帧重新塞回上下文。
  let latestToolRoundStart = -1;
  const fileReadCalls = new Map<string, string>();
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      latestToolRoundStart = index;
      fileReadCalls.clear();
      for (const call of message.toolCalls) {
        if (call.name !== 'file_read') continue;
        try {
          const args = JSON.parse(call.arguments) as { path?: unknown };
          if (typeof args.path === 'string') fileReadCalls.set(call.id, args.path);
        } catch { /* 参数错误由工具执行阶段处理；不允许其产生图片输入。 */ }
      }
    }
  });
  const toolRoundOpen = latestToolRoundStart >= 0
    && !messages.slice(latestToolRoundStart + 1).some((message) => message.role === 'assistant');
  const hydrated: LlmMessage[] = [];
  const pendingToolImages: LlmContentPart[] = [];
  const flushToolImages = () => {
    if (!pendingToolImages.length) return;
    hydrated.push({
      role: 'user',
      content: '以下图片来自刚刚读取的文件，请结合图片内容继续分析。',
      contentParts: [...pendingToolImages],
    });
    pendingToolImages.length = 0;
  };
  for (const [index, message] of messages.entries()) {
    if ((message.role !== 'user' && message.role !== 'tool') || !message.content) {
      if (message.role !== 'tool') flushToolImages();
      hydrated.push(message);
      continue;
    }

    const tokens = parseFileTokens(message.content).filter((token) => {
      if (message.role === 'user') return true;
      if (!toolRoundOpen || index <= latestToolRoundStart || token.kind !== TOOL_IMAGE_KIND || !token.callId) return false;
      if (message.toolCallId !== token.callId) return false;
      const requestedPath = fileReadCalls.get(token.callId);
      if (!requestedPath) return false;
      const absolute = attachmentPath(requestedPath, workspaceRoot, userFilesRoot);
      const expected = userFilesRoot && isWithin(userFilesRoot, absolute) ? absolute : toRemotePath(absolute, workspaceRoot);
      return expected === token.path;
    });
    if (!tokens.length) {
      // 同一轮可能同时包含图片读取和普通工具结果；全部工具结果结束后才能插入用户图片消息。
      if (message.role !== 'tool') flushToolImages();
      hydrated.push(message);
      continue;
    }

    const imageParts: LlmContentPart[] = [];
    for (const token of tokens) {
      const part = await loadImageToken(token, workspaceRoot, userFilesRoot);
      if (part) imageParts.push(part);
    }

    if (!imageParts.length) {
      if (message.role !== 'tool') flushToolImages();
      hydrated.push(message);
      continue;
    }

    if (message.role === 'tool') {
      // 保持本轮所有 tool_result 连续，图片在整轮工具结果之后作为用户多模态消息传入。
      hydrated.push({ ...message, content: message.content.replace(FILE_TOKEN_RE, '').trim() });
      pendingToolImages.push(...imageParts);
    } else {
      flushToolImages();
      const text = cleanAttachmentText(message.content, imageParts);
      hydrated.push({
        ...message,
        contentParts: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...imageParts,
        ],
      });
    }
  }
  flushToolImages();
  return hydrated;
}
