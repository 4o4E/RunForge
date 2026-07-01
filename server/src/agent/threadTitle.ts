import type { Provider } from '../llm/types.js';
import type { Store, ThreadRow } from '../store/types.js';

const MAX_TITLE_CHARS = 30;
const MAX_TRANSCRIPT_CHARS = 6000;

export interface ThreadTitleDeps {
  store: Store;
  provider: Provider;
}

function compactOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cleanGeneratedTitle(value: string | null): string {
  const firstLine = (value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const cleaned = firstLine
    .replace(/^```(?:json|text)?/i, '')
    .replace(/```$/g, '')
    .replace(/^(?:title|标题|对话标题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[。.!！?？,，;；:：]+$/g, '')
    .trim();
  return Array.from(cleaned).slice(0, MAX_TITLE_CHARS).join('').trim();
}

function fallbackTitle(input: string): string {
  return Array.from(compactOneLine(input).replace(/[。.!！?？,，;；:：]+$/g, ''))
    .slice(0, MAX_TITLE_CHARS)
    .join('')
    .trim();
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

async function titleTarget(runId: string, store: Store) {
  const run = await store.getRun(runId);
  if (!run || run.status !== 'done') return null;
  const thread = await store.getThread(run.thread_id);
  if (!thread || thread.title?.trim()) return null;
  const runs = await store.listRuns(run.thread_id);
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

export async function maybeGenerateThreadTitleAfterFirstRun(runId: string, deps: ThreadTitleDeps): Promise<ThreadRow | null> {
  const target = await titleTarget(runId, deps.store);
  if (!target) return null;

  const result = await deps.provider.complete(
    [
      {
        role: 'system',
        content: [
          '你是 thread 标题生成器。请根据首轮用户请求和助手最终回复，生成一个简洁中文标题。',
          'You are a thread title generator. Based on the completed conversation branch, generate one concise Chinese title.',
          '只输出标题本身，不要解释，不要加引号，不要超过 30 个中文字符。',
          'Return only the title itself. Do not explain, do not quote it, and keep it within 30 Chinese characters.',
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
  return deps.store.setThreadTitleIfEmpty(target.thread.id, title);
}

export function scheduleThreadTitleGeneration(runId: string, deps: ThreadTitleDeps): void {
  void maybeGenerateThreadTitleAfterFirstRun(runId, deps).catch((err) => {
    console.warn(`thread title generation skipped for ${runId}: ${(err as Error).message}`);
  });
}
