import { readFile, stat } from 'node:fs/promises';
import type { LlmContentPart, LlmMediaRef, LlmMessage } from './types.js';
import { isImageMediaType, mediaTypeFromPath, normalizeRemotePath, toRemotePath } from '../files/workspace.js';
import { resolveWorkspaceFilePath } from '../files/workspace.js';
import { isWithin } from '../tools/policy.js';
import { isAbsolute, resolve } from 'node:path';
import { ImageInputRejectedError, prepareModelImage } from './imageInput.js';

const FILE_TOKEN_RE = /\[\[file:({.*?})\]\]/g;
const TOOL_IMAGE_KIND = 'tool-image';
const MAX_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_MODEL_IMAGES_PER_REQUEST = 8;

export interface ImageAttachmentIssue {
  path: string;
  name: string;
  reason: string;
}

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

/** 用户消息仍保留原始附件标记；额外记录类型与路径供恢复和文件读取使用。 */
export function mediaRefsFromUserText(text: string): LlmMediaRef[] {
  return parseFileTokens(text).map((token) => {
    const mimeType = token.mimeType?.trim() || mediaTypeFromPath(token.path);
    return {
      type: isImageMediaType(mimeType) ? 'image' : 'file',
      path: token.path,
      mimeType,
      name: token.name,
    };
  });
}

function cleanAttachmentText(text: string, images: LlmContentPart[]): string {
  const imagePaths = new Set(images.filter((part) => part.type === 'image').map((part) => part.path));
  let cleaned = text.replace(FILE_TOKEN_RE, (raw) => {
    const token = parseFileTokens(raw)[0];
    if (!token) return raw;
    return imagePaths.has(token.path) ? '' : `附件文件：${token.name ?? token.path}（${token.path}）`;
  }).trim();
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
  if (info.size > MAX_IMAGE_SOURCE_BYTES) {
    if (!isImageMediaType(mediaType)) return null;
    throw new ImageInputRejectedError(`图片附件超过 ${MAX_IMAGE_SOURCE_BYTES} 字节读取上限`);
  }

  const data = await readFile(absolute);
  const prepared = await prepareModelImage(data, mediaType);
  if (!prepared) return null;
  return {
    type: 'image',
    data: prepared.data,
    mimeType: prepared.mimeType,
    path: userFilesRoot && isWithin(userFilesRoot, absolute) ? absolute : toRemotePath(absolute, workspaceRoot),
    name: token.name,
  };
}

export async function hydrateImageAttachments(
  messages: LlmMessage[], workspaceRoot: string, userFilesRoot?: string,
  options: { allowImages?: boolean; maxImages?: number; issues?: ImageAttachmentIssue[] } = {},
): Promise<LlmMessage[]> {
  // 工具图片只属于最近一轮 tool_call：模型已经消费过的旧帧不重复装载，避免每轮把全部关键帧重新塞回上下文。
  let latestToolRoundStart = -1;
  let latestAssistantIndex = -1;
  const fileReadCalls = new Map<string, string>();
  messages.forEach((message, index) => {
    if (message.role === 'assistant') latestAssistantIndex = index;
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
  let acceptedImages = 0;
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
    if ((message.role !== 'user' && message.role !== 'tool') || (!message.content && !message.mediaRefs?.length)) {
      if (message.role !== 'tool') flushToolImages();
      hydrated.push(message);
      continue;
    }

    const refs = message.mediaRefs?.map((ref): FileToken => ({
      raw: '', path: ref.path, name: ref.name, mimeType: ref.mimeType,
    })) ?? [];
    const sourceTokens = message.mediaRefs !== undefined ? refs : parseFileTokens(message.content ?? '');
    const tokens = sourceTokens.filter((token) => {
      if (message.role === 'user') return index > latestAssistantIndex;
      if (refs.length) {
        return toolRoundOpen && index > latestToolRoundStart
          && Boolean(message.toolCallId && fileReadCalls.has(message.toolCallId));
      }
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
    const localIssues: ImageAttachmentIssue[] = [];
    for (const token of tokens) {
      if (acceptedImages >= Math.min(MAX_MODEL_IMAGES_PER_REQUEST, options.maxImages ?? MAX_MODEL_IMAGES_PER_REQUEST)) {
        const mediaType = token.mimeType?.trim() || mediaTypeFromPath(token.path);
        if (isImageMediaType(mediaType)) {
          localIssues.push({ path: token.path, name: token.name ?? token.path, reason: options.maxImages === undefined
            ? `单次请求最多读取 ${MAX_MODEL_IMAGES_PER_REQUEST} 张图片`
            : '当前上下文预算不足以读取更多图片' });
        }
        continue;
      }
      if (options.allowImages === false) {
        const mimeType = token.mimeType?.trim() || mediaTypeFromPath(token.path);
        if (!isImageMediaType(mimeType)) continue;
        localIssues.push({ path: token.path, name: token.name ?? token.path, reason: '当前模型未启用图片输入' });
        continue;
      }
      try {
        const part = await loadImageToken(token, workspaceRoot, userFilesRoot);
        if (part) {
          imageParts.push(part);
          acceptedImages += 1;
        }
      } catch (error) {
        if (!(error instanceof ImageInputRejectedError)
          && (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT')) throw error;
        localIssues.push({ path: token.path, name: token.name ?? token.path, reason: (error as Error).message });
      }
    }
    options.issues?.push(...localIssues);
    const issueText = localIssues.map((issue) => `附件图片 ${issue.name} 未进入模型：${issue.reason}。请勿推断其内容。`).join('\n');

    if (!imageParts.length) {
      if (message.role !== 'tool') flushToolImages();
      hydrated.push(issueText ? { ...message, content: `${message.content ?? ''}\n\n${issueText}`.trim() } : message);
      continue;
    }

    if (message.role === 'tool') {
      // 保持本轮所有 tool_result 连续，图片在整轮工具结果之后作为用户多模态消息传入。
      hydrated.push({ ...message, content: `${(message.content ?? '').replace(FILE_TOKEN_RE, '').trim()}${issueText ? `\n\n${issueText}` : ''}`.trim() });
      pendingToolImages.push(...imageParts);
    } else {
      flushToolImages();
      const text = `${cleanAttachmentText(message.content ?? '', imageParts)}${issueText ? `\n\n${issueText}` : ''}`.trim();
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
