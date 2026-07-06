import type { Tool } from './types.js';

// Very small HTML → text reduction (strip tags/scripts). Good enough for a skeleton.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateFetchText(text: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 8000;
  if (text.length <= limit) return text;
  let marker = '';
  let keep = limit;
  for (let i = 0; i < 3; i++) {
    marker = `\n…[web_fetch 已按 max_chars 截断 ${text.length - keep} 个字符]`;
    keep = Math.max(0, limit - marker.length);
  }
  if (marker.length > limit) return marker.slice(0, limit);
  return `${text.slice(0, keep)}${marker}`;
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: '抓取 URL 并以文本形式返回内容；HTML 会被简化为纯文本。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 URL（http/https）' },
      max_chars: { type: 'number', description: '结果最多保留多少字符，默认 8000' },
    },
    required: ['url'],
  },
  async run(args) {
    const url = String(args.url ?? '');
    const maxChars = Number(args.max_chars ?? 8000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'RunForge/0.1' } });
      if (!res.ok) return `抓取失败（${res.status}）：${url}`;
      const ct = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const text = ct.includes('html') ? htmlToText(raw) : raw;
      return truncateFetchText(text, maxChars);
    } catch (err) {
      return `抓取失败 ${url}: ${(err as Error).message}`;
    }
  },
};
