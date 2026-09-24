import type { LlmMessage } from './types.js';

export interface OmittedImage {
  path: string;
  name: string;
}

/** 仅检查明确的上游图片拒绝；网络、鉴权和额度错误不能被改写成文本续聊。 */
export function isExplicitImageRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const row = error as { statusCode?: unknown; status?: unknown; responseBody?: unknown; data?: unknown; message?: unknown };
  const status = typeof row.statusCode === 'number' ? row.statusCode : row.status;
  if (status !== 400 && status !== 415 && status !== 422) return false;
  const detail = [row.responseBody, row.data, row.message]
    .map((value) => typeof value === 'string' ? value : JSON.stringify(value ?? ''))
    .join(' ');
  return (/(?:image|vision|image_url|input_image)/i.test(detail)
    && /(?:not supported|unsupported|does not support|not accept|invalid image format)/i.test(detail))
    || /(?:不支持|无法处理|不接受).{0,24}(?:图片|图像)|(?:图片|图像).{0,24}(?:不支持|无法处理|不接受)/.test(detail);
}

/** 仅派生本次请求的纯文本视图，不修改持久化的用户消息和文件引用。 */
export function omitImagesForTextContinuation(messages: LlmMessage[]): { messages: LlmMessage[]; omitted: OmittedImage[] } {
  const omitted: OmittedImage[] = [];
  const textMessages = messages.map((message) => {
    const images = message.contentParts?.filter((part) => part.type === 'image') ?? [];
    if (!images.length) return message;
    omitted.push(...images.map((part) => ({ path: part.path, name: part.name ?? part.path })));
    let text = message.contentParts?.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      || message.content || '';
    if (text.startsWith('以下图片来自刚刚读取的文件，请结合图片内容继续分析。')) {
      text = '刚才的文件读取产生了图片附件。';
    }
    const names = images.map((part) => part.name ?? part.path).join('、');
    return {
      ...message,
      content: `${text}\n\n[本轮图片内容未进入模型：${names}。请勿推断图片中的具体内容；如需分析，请说明当前无法查看图片。]`.trim(),
      contentParts: undefined,
    };
  });
  return { messages: textMessages, omitted };
}
