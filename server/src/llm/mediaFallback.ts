import type { LlmMessage } from './types.js';

export interface OmittedImage {
  path: string;
  name: string;
}

/** 只有上游明确否定模型的图片能力才降级；格式、尺寸和泛化的 unsupported image 只属于本次输入。 */
export function isExplicitImageRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const row = error as { statusCode?: unknown; status?: unknown; responseBody?: unknown; data?: unknown; message?: unknown };
  const status = typeof row.statusCode === 'number' ? row.statusCode : row.status;
  if (status !== 400 && status !== 415 && status !== 422) return false;
  const detail = [row.responseBody, row.data, row.message]
    .map((value) => typeof value === 'string' ? value : JSON.stringify(value ?? ''))
    .join(' ');
  return /\bmodel\b[^\n.!?]{0,80}\b(?:does\s+not|doesn't|cannot|can't|can\s+not)\s+(?:support|accept|process)\s+(?:(?:any|the)\s+)?(?:images?|image\s+inputs?|vision|visual\s+inputs?)(?=\s*(?:[.,;:!?\n"'}\]]|$))/i.test(detail)
    || /\b(?:images?|image\s+inputs?|vision|visual\s+inputs?)\s+(?:are|is)\s+not\s+supported\s+by\s+(?:(?:this|the|current|selected)\s+)?model\b/i.test(detail)
    || /\b(?:this|the|current|selected)\s+model\s+(?:is|supports?)\s+(?:text-only|only\s+text)\b/i.test(detail)
    || /模型[^。\n！？]{0,40}(?:不支持|不接受|无法处理)(?:图片|图像|视觉)(?:输入)?(?=\s*(?:[。，；：！？\n"'}\]]|$))/.test(detail);
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
      content: `${text}\n\n[本轮图片内容未进入模型：${names}。请勿推断图片中的具体内容；当前模型无法查看图片，请选择支持图片的多模态模型后重新读取。]`.trim(),
      contentParts: undefined,
    };
  });
  return { messages: textMessages, omitted };
}
