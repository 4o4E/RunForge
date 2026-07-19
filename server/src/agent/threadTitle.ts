import type { Provider } from '../llm/types.js';
import type { Scope, Store, ThreadRow } from '../store/types.js';

const MAX_TITLE_DISPLAY_WIDTH = 24;
const MAX_TRANSCRIPT_CHARS = 6000;

export interface ThreadTitleDeps {
  store: Store;
  provider: Provider;
}

function compactOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function titleDisplayWidth(value: string): number {
  return Array.from(value).reduce((sum, char) => sum + (/^[\x00-\x7F]$/.test(char) ? 1 : 2), 0);
}

function sliceTitleByDisplayWidth(value: string): string {
  let width = 0;
  const chars: string[] = [];
  for (const char of Array.from(value)) {
    const nextWidth = /^[\x00-\x7F]$/.test(char) ? 1 : 2;
    if (width + nextWidth > MAX_TITLE_DISPLAY_WIDTH) break;
    chars.push(char);
    width += nextWidth;
  }
  return chars.join('').trim();
}

function titleFromJsonLike(value: string): string | null {
  const match = value.match(/["']?(?:title|标题)["']?\s*[:：]\s*["'“”‘’`]?([^"'“”‘’`\n\r{}]+)/i);
  return match?.[1]?.trim() || null;
}

function normalizeTitleCandidate(value: string): string {
  return compactOneLine(value)
    .replace(/^```(?:json|text)?/i, '')
    .replace(/```$/g, '')
    .replace(/^(?:title|标题|对话标题)\s*[:：]\s*/i, '')
    .replace(/^(?:请帮我|帮我|请|关于|围绕|分析一下|分析|总结一下|总结)\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[。.!！?？,，;；:：]+$/g, '')
    .trim();
}

function conciseTitle(value: string | null): string {
  const raw = value ?? '';
  const jsonTitle = titleFromJsonLike(raw);
  const normalized = normalizeTitleCandidate(jsonTitle ?? raw);
  // 模型偶尔会返回解释性长句；优先取冒号、逗号等分隔前的主题短语。
  const segments = normalized
    .split(/[。.!！?？;；:：,，|｜/]+/)
    .map(normalizeTitleCandidate)
    .filter(Boolean);
  const candidate = segments.find((segment) => titleDisplayWidth(segment) >= 6) ?? segments[0] ?? normalized;
  return sliceTitleByDisplayWidth(candidate);
}

function cleanGeneratedTitle(value: string | null): string {
  const jsonTitle = titleFromJsonLike(value ?? '');
  if (jsonTitle) return conciseTitle(jsonTitle);
  const firstLine = (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^```/.test(line)) ?? '';
  return conciseTitle(firstLine);
}

function fallbackTitle(input: string): string {
  return conciseTitle(input);
}

function truncateChars(value: string | null, maxChars: number): string {
  const chars = Array.from(compactOneLine(value ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}...`;
}

function branchRunsEndingAt(runs: Awaited<ReturnType<Store['listRuns']>>, runId: string) {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const path = [];
  let cursor = byId.get(runId);
  while (cursor) {
    path.push(cursor);
    cursor = cursor.parent_run_id ? byId.get(cursor.parent_run_id) : undefined;
  }
  return path.reverse();
}

async function titleTarget(scope: Scope, runId: string, store: Store) {
  const run = await store.getRun(scope, runId);
  if (!run || run.status !== 'done') return null;
  const thread = await store.getThread(scope, run.thread_id);
  if (!thread || thread.title?.trim()) return null;
  const runs = await store.listRuns(scope, run.thread_id);
  const branchRuns = branchRunsEndingAt(runs, run.id).filter((item) => item.status === 'done');
  if (!branchRuns.length) return null;
  return { run, thread, branchRuns };
}

function renderTitleTranscript(runs: Awaited<ReturnType<Store['listRuns']>>): string {
  const blocks = runs.map((run, index) => [
    `第 ${index + 1} 轮用户请求 / User request ${index + 1}:`,
    truncateChars(run.input, 800),
    '',
    `第 ${index + 1} 轮助手最终回复摘要材料 / Assistant final answer material ${index + 1}:`,
    truncateChars(run.output, 1200),
  ].join('\n'));
  return truncateChars(blocks.join('\n\n---\n\n'), MAX_TRANSCRIPT_CHARS);
}

export async function maybeGenerateThreadTitleAfterFirstRun(scope: Scope, runId: string, deps: ThreadTitleDeps): Promise<ThreadRow | null> {
  const target = await titleTarget(scope, runId, deps.store);
  if (!target) return null;

  const result = await deps.provider.complete(
    [
      {
        role: 'system',
        content: [
          '你是 thread 标题生成器。请根据已完成对话分支，生成一个适合侧栏展示的极简中文标题。',
          'You are a thread title generator. Based on the completed conversation branch, generate an ultra-concise Chinese title for a sidebar.',
          '只输出标题本身，不要解释，不要加引号；使用名词短语，不要写成句子或摘要。',
          'Return only the title itself. Do not explain or quote it; use a noun phrase, not a sentence or summary.',
          '中文标题控制在 6 到 12 个汉字；中英混合标题宽度不要超过 24 个半角字符。',
          'Keep Chinese titles within 6 to 12 Han characters; keep mixed Chinese/English titles within 24 half-width characters.',
          '好例子：画图写实风格、跨平台对话优化、AWS自动更新DNS服务。',
          'Good examples: 画图写实风格, 跨平台对话优化, AWS自动更新DNS服务.',
          '坏例子：请帮我分析跨平台对话模型优化方案、关于AWS自动更新DNS服务的实现建议。',
          'Bad examples: 请帮我分析跨平台对话模型优化方案, 关于AWS自动更新DNS服务的实现建议.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          '已完成分支材料 / Completed branch material:',
          renderTitleTranscript(target.branchRuns),
        ].join('\n'),
      },
    ],
    [],
  );

  const title = cleanGeneratedTitle(result.content) || fallbackTitle(target.run.input);
  if (!title) return null;
  return deps.store.setThreadTitleIfEmpty(scope, target.thread.id, title);
}

export function scheduleThreadTitleGeneration(scope: Scope, runId: string, deps: ThreadTitleDeps): void {
  void maybeGenerateThreadTitleAfterFirstRun(scope, runId, deps).catch((err) => {
    console.warn(`thread title generation skipped for ${runId}: ${(err as Error).message}`);
  });
}
