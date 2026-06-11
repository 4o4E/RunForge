import type { Tool } from './types.js';

// Keyless web search via DuckDuckGo's HTML endpoint. Best-effort for a skeleton;
// swap in a real search API (Bing/Brave/SerpAPI) for production quality.
export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web and return a list of result titles and URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async run(args) {
    const query = String(args.query ?? '');
    try {
      const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: { 'User-Agent': 'Mozilla/5.0 my-agent/0.1' },
      });
      if (!res.ok) return `Search failed (${res.status})`;
      const html = await res.text();
      const results: string[] = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && results.length < 10) {
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        results.push(`- ${title}\n  ${m[1]}`);
      }
      return results.length ? results.join('\n') : '(no results)';
    } catch (err) {
      return `Search error: ${(err as Error).message}`;
    }
  },
};
