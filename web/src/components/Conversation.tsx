import type { UIMessage } from 'ai';
import { Activity, Bot, Check, ChevronDown, Copy, Fingerprint, FileText, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  Conversation as AIConversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageAction, MessageActions, MessageContent } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import type { ToolUIPart } from 'ai';
import { TableOfContents } from './TableOfContents';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './MarkdownContent';
import type { StreamdownProps } from 'streamdown';
import { AskUserQuestionCard, emptyAskUserDraft, type AskUserDraft } from './AskUserCard';
import type { AskUserAnswer, AskUserSpec, GoalState, StreamStats } from '@/api';

type Part = UIMessage['parts'][number];
type Timing = { startedAt?: string; endedAt?: string; durationMs?: number };
type ActivityEntry = { part: Part; index: number };
type FileToken = { kind?: string; path: string; name?: string; size?: number };

const RELATIVE_PATH_RE = /(?:\.{1,2}\/)?(?:server|web|docs|src|uploads|tests)\/[A-Za-z0-9._~+/@:-]+/g;
const FILE_LINK_PREFIX = 'my-agent-file://';
const STREAM_STATS_POINTS = 24;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isToolPart(p: Part): boolean {
  return p.type === 'dynamic-tool' || p.type.startsWith('tool-');
}

function isReasoningPart(p: Part): p is Extract<Part, { type: 'reasoning' }> {
  return p.type === 'reasoning';
}

function isActivityPart(p: Part): boolean {
  return isToolPart(p) || isReasoningPart(p);
}

function isHiddenDataPart(p: Part): boolean {
  return p.type === 'data-run-id'
    || p.type === 'data-message-time'
    || p.type === 'data-tool-timing'
    || p.type === 'data-reasoning-timing'
    || p.type === 'data-stream-stats'
    || p.type === 'data-usage-update'
    || p.type === 'data-final-output'
    || p.type === 'data-plan-state';
}

function messageTime(message: UIMessage): string | null {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i] as { type: string; data?: { sentAt?: string; completedAt?: string } };
    if (part.type !== 'data-message-time') continue;
    const value = message.role === 'assistant' ? part.data?.completedAt : part.data?.sentAt;
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return null;
}

function durationFromTiming(t?: Timing): number | undefined {
  if (!t) return undefined;
  if (t.startedAt && t.endedAt) {
    return Math.max(0, new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime());
  }
  return t.durationMs;
}

function MiniSparkline({ values }: { values: number[] }) {
  const width = 92;
  const height = 24;
  const samples = values.length ? values.map((value) => Math.max(0, value)) : [0];
  const max = Math.max(1, ...samples);
  const points = samples.map((value, index) => {
    const x = samples.length === 1 ? width : (index / (samples.length - 1)) * width;
    const y = height - (value / max) * (height - 4) - 2;
    return {
      value,
      x,
      y,
    };
  });
  const segmentPath = (index: number) => {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    if (p1.value === 0 && p2.value === 0) return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    return [
      `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`,
      `C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    ].join(' ');
  };

  return (
    <svg className="h-6 w-[92px] overflow-visible" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {points.length === 1 ? (
        <circle
          cx={points[0].x}
          cy={points[0].y}
          r="1.5"
          fill={points[0].value === 0 ? 'hsl(var(--muted-foreground))' : 'currentColor'}
          opacity={points[0].value === 0 ? 0.45 : 1}
        />
      ) : (
        points.slice(0, -1).map((point, index) => {
          const next = points[index + 1];
          const isZero = point.value === 0 && next.value === 0;
          return (
            <path
              key={index}
              d={segmentPath(index)}
              fill="none"
              stroke={isZero ? 'hsl(var(--muted-foreground))' : 'currentColor'}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={isZero ? 0.45 : 1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })
      )}
    </svg>
  );
}

function ProcessingDots() {
  return (
    <span className="flex items-end gap-0.5" aria-hidden="true">
      <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:-240ms]" />
      <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:-120ms]" />
      <span className="size-1 animate-pulse rounded-full bg-current" />
    </span>
  );
}

function useCopyFeedback(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return [copied, () => setCopied(true)];
}

function CopyRunButton({ runId, className }: { runId: string | null; className?: string }) {
  const [copied, markCopied] = useCopyFeedback();
  return (
    <MessageAction
      tooltip={copied ? '已复制' : runId ? '复制 run id' : '暂无 run id'}
      label="复制 run id"
      disabled={!runId}
      onClick={async () => {
        if (runId && await copyToClipboard(runId)) markCopied();
      }}
      className={className}
    >
      {copied ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Fingerprint className="size-3.5" />}
    </MessageAction>
  );
}

function StreamStatusBar({ parts, active, time, runId }: { parts: Part[]; active: boolean; time: string | null; runId: string | null }) {
  const stats = latestStreamStats(parts);
  if (!stats && !time && !runId) return null;
  const running = !!stats && active && stats.stage !== 'done' && stats.stage !== 'error';
  const charsPerSecond = Math.round(stats?.rate.charsPerSecond ?? 0);

  return (
    <div className="not-prose mt-3 flex min-h-8 w-full flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
      {stats && (
        <span className="inline-flex items-center gap-1.5">
          <Activity className={cn('size-3.5', running && 'animate-pulse text-primary')} />
          <span>{streamStageLabel(stats)}</span>
          {running && <ProcessingDots />}
        </span>
      )}
      {time && <span className="tabular-nums">{time}</span>}
      <span className="inline-flex items-center">
        <CopyRunButton runId={runId} className="size-6 text-muted-foreground" />
      </span>
      {stats && running && (
        <>
          <span className="tabular-nums">{charsPerSecond.toLocaleString()} 字/秒</span>
          <span className="text-primary/80">
            <MiniSparkline values={stats.rate.history.slice(-STREAM_STATS_POINTS)} />
          </span>
        </>
      )}
    </div>
  );
}

export function latestStreamStats(parts: Part[]): StreamStats | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as { type: string; data?: StreamStats };
    if (part.type === 'data-stream-stats' && part.data) return part.data;
  }
  return null;
}

export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  estContextTokens?: number;
  contextBudget?: number;
}

export function latestUsageSnapshot(parts: Part[]): UsageSnapshot | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as { type: string; data?: UsageSnapshot };
    if (part.type === 'data-usage-update' && part.data) return part.data;
  }
  return null;
}

function finalTextIndex(parts: Part[]): number | null {
  const finalIndex = parts.findIndex((part) => part.type === 'data-final-output');
  if (finalIndex < 0) return null;
  for (let i = finalIndex - 1; i >= 0; i--) {
    const part = parts[i] as { type: string; text?: string };
    if (part.type === 'text' && part.text) return i;
  }
  return null;
}

function streamStageLabel(stats: StreamStats): string {
  const tool = stats.activeTool?.name ? ` · ${stats.activeTool.name}` : '';
  if (stats.stage === 'llm_waiting') return '等待模型';
  if (stats.stage === 'reasoning') return '思考中';
  if (stats.stage === 'output') return '输出中';
  if (stats.stage === 'tool_call') return `准备调用工具${tool}`;
  if (stats.stage === 'tool_running') return `工具执行中${tool}`;
  if (stats.stage === 'tool_result') return `工具已返回${tool}`;
  if (stats.stage === 'error') return '运行出错';
  return '输出完成';
}

export function latestPlanState(messages: UIMessage[]): GoalState | null {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const message = messages[mi];
    if (message.role !== 'assistant') continue;
    for (let pi = message.parts.length - 1; pi >= 0; pi--) {
      const part = message.parts[pi] as { type: string; data?: GoalState };
      if (part.type === 'data-plan-state' && part.data?.plan?.length) return part.data;
    }
  }
  return null;
}

function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}m ${rest}s`;
}

function groupDuration(entries: ActivityEntry[], timingMaps: ReturnType<typeof buildTimingMaps>): number | undefined {
  let started: number | null = null;
  let ended: number | null = null;

  for (const entry of entries) {
    const timing = timingForPart(entry.part, timingMaps);
    if (!timing?.startedAt || !timing?.endedAt) continue;
    const start = new Date(timing.startedAt).getTime();
    const end = new Date(timing.endedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    started = started == null ? start : Math.min(started, start);
    ended = ended == null ? end : Math.max(ended, end);
  }

  return started != null && ended != null ? Math.max(0, ended - started) : undefined;
}

function partId(part: Part): string | undefined {
  const p = part as { id?: string; toolCallId?: string };
  return p.toolCallId ?? p.id;
}

function buildTimingMaps(parts: Part[]) {
  const tools = new Map<string, Timing>();
  const reasoning = new Map<string, Timing>();
  for (const part of parts) {
    if (part.type === 'data-tool-timing') {
      const data = (part as { data?: Timing & { id?: string } }).data;
      if (data?.id) tools.set(data.id, data);
    }
    if (part.type === 'data-reasoning-timing') {
      const data = (part as { id?: string; data?: Timing & { step?: number } });
      const id = data.id ?? (data.data?.step ? `r-${data.data.step}` : undefined);
      if (id) reasoning.set(id, data.data ?? {});
    }
  }
  return { tools, reasoning };
}

function timingForPart(part: Part, maps: ReturnType<typeof buildTimingMaps>): Timing | undefined {
  const id = partId(part);
  if (isToolPart(part)) return id ? maps.tools.get(id) ?? (part as unknown as Timing) : (part as unknown as Timing);
  if (isReasoningPart(part)) return id ? maps.reasoning.get(id) ?? (part as unknown as Timing) : (part as unknown as Timing);
  return undefined;
}

function trimPathToken(value: string): { label: string; path: string; suffix: string } {
  const withoutPunctuation = value.replace(/[),.;\]]+$/, '');
  const suffix = value.slice(withoutPunctuation.length);
  const path = withoutPunctuation.replace(/(?::\d+){1,2}$/, '');
  return { label: withoutPunctuation, path, suffix };
}

function pathRegex(workspaceRoot: string | null): RegExp {
  const relative = RELATIVE_PATH_RE.source;
  const root = workspaceRoot ? `${escapeRegExp(workspaceRoot.replace(/\/+$/, ''))}/[A-Za-z0-9._~+/@:-]+` : '';
  return new RegExp(root ? `${root}|${relative}` : relative, 'g');
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1');
}

function fileHref(path: string): string {
  return `${FILE_LINK_PREFIX}${encodeURIComponent(path)}`;
}

function pathFromHref(href: string): string | null {
  if (!href.startsWith(FILE_LINK_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(FILE_LINK_PREFIX.length));
  } catch {
    return href.slice(FILE_LINK_PREFIX.length);
  }
}

function linkifyPathChunk(text: string, workspaceRoot: string | null): string {
  let linked = '';
  const re = pathRegex(workspaceRoot);
  let lastIndex = 0;

  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const { label, path, suffix } = trimPathToken(raw);
    linked += text.slice(lastIndex, start);
    linked += `[${escapeMarkdownLinkLabel(label)}](${fileHref(path)})${suffix}`;
    lastIndex = start + raw.length;
  }
  return linked + text.slice(lastIndex);
}

function linkifyPaths(text: string, workspaceRoot: string | null): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((chunk) => (chunk.startsWith('`') ? chunk : linkifyPathChunk(chunk, workspaceRoot)))
    .join('');
}

function PathAwareResponse({ text, workspaceRoot, onOpenRemoteFile }: { text: string; workspaceRoot: string | null; onOpenRemoteFile: (path: string) => void }) {
  const linkedText = linkifyPaths(text, workspaceRoot);
  const components: StreamdownProps['components'] = {
    a: ({ href, children, ...props }) => {
      const path = typeof href === 'string' ? pathFromHref(href) : null;
      if (!path) return <a href={href} {...props}>{children}</a>;
      return (
        <button
          type="button"
          onClick={() => onOpenRemoteFile(path)}
          className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 align-baseline text-xs text-muted-foreground hover:text-foreground"
          title={path}
        >
          <FileText className="size-3" />
          <span className="truncate">{children}</span>
        </button>
      );
    },
  };

  return <MarkdownContent text={linkedText} components={components} />;
}

// `active` 标记最新工具调用；新工具出现时旧块自动折叠，用户手动切换会临时覆盖。
function ToolBlock({
  part,
  active,
  timing,
  workspaceRoot,
  onOpenRemoteFile,
}: {
  part: Part;
  active: boolean;
  timing?: Timing;
  workspaceRoot: string | null;
  onOpenRemoteFile: (path: string) => void;
}) {
  const p = part as {
    type: string;
    toolName?: string;
    state: ToolUIPart['state'];
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  const [override, setOverride] = useState<boolean | null>(null);
  const prevActive = useRef(active);
  useEffect(() => {
    if (prevActive.current !== active) {
      prevActive.current = active;
      setOverride(null);
    }
  }, [active]);
  const open = override ?? active;
  return (
    <Tool open={open} onOpenChange={setOverride}>
      {p.type === 'dynamic-tool' ? (
        <ToolHeader type="dynamic-tool" toolName={p.toolName ?? 'tool'} state={p.state} duration={formatDuration(durationFromTiming(timing))} />
      ) : (
        <ToolHeader type={p.type as ToolUIPart['type']} state={p.state} duration={formatDuration(durationFromTiming(timing))} />
      )}
      <ToolContent>
        <ToolInput input={p.input} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
        <ToolOutput output={p.output as never} errorText={p.errorText} />
      </ToolContent>
    </Tool>
  );
}

function AssistantPart({
  part,
  answer,
  canceled,
  toolActive,
  timingMaps,
  workspaceRoot,
  onOpenRemoteFile,
  runId,
  askUserDrafts,
  onAskUserDraftChange,
  onAskUserSubmit,
  onAskUserCancel,
}: {
  part: Part;
  answer?: AskUserAnswer;
  canceled?: boolean;
  toolActive: boolean;
  timingMaps: ReturnType<typeof buildTimingMaps>;
  workspaceRoot: string | null;
  onOpenRemoteFile: (path: string) => void;
  runId: string | null;
  askUserDrafts: Record<string, AskUserDraft>;
  onAskUserDraftChange: (runId: string, draft: AskUserDraft) => void;
  onAskUserSubmit: (runId: string, answer: AskUserAnswer) => void;
  onAskUserCancel: (runId: string) => void;
}) {
  if (part.type === 'text') return part.text ? <PathAwareResponse text={part.text} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} /> : null;
  if (part.type === 'reasoning') {
    const duration = durationFromTiming(timingForPart(part, timingMaps));
    return part.text ? (
      <Reasoning isStreaming={part.state === 'streaming'} defaultOpen={part.state === 'streaming'} duration={duration ? Math.ceil(duration / 1000) : undefined}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    ) : null;
  }
  if (part.type === 'data-ask-user-question') {
    const spec = (part as { data: AskUserSpec }).data;
    const draft = runId ? askUserDrafts[runId] ?? emptyAskUserDraft(spec) : emptyAskUserDraft(spec);
    return (
      <AskUserQuestionCard
        spec={spec}
        draft={draft}
        answer={answer}
        canceled={canceled}
        disabled={!runId}
        onDraftChange={(next) => runId && onAskUserDraftChange(runId, next)}
        onSubmit={(answer) => runId && onAskUserSubmit(runId, answer)}
        onCancel={() => runId && onAskUserCancel(runId)}
      />
    );
  }
  if (part.type === 'data-ask-user-answer') {
    return null;
  }
  if (part.type === 'data-ask-user-cancel') {
    return null;
  }
  if (isToolPart(part)) {
    return (
      <ToolBlock
        part={part}
        active={toolActive}
        timing={timingForPart(part, timingMaps)}
        workspaceRoot={workspaceRoot}
        onOpenRemoteFile={onOpenRemoteFile}
      />
    );
  }
  return null;
}

function askUserStateForQuestion(parts: Part[], index: number): { answer?: AskUserAnswer; canceled?: boolean } {
  for (let i = index + 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === 'data-ask-user-question') return {};
    if (part.type === 'data-ask-user-answer') return { answer: (part as { data: AskUserAnswer }).data };
    if (part.type === 'data-ask-user-cancel') return { canceled: true };
  }
  return {};
}

function ActivityGroup({
  entries,
  active,
  lastToolKey,
  messageId,
  timingMaps,
  workspaceRoot,
  onOpenRemoteFile,
  runId,
  askUserDrafts,
  onAskUserDraftChange,
  onAskUserSubmit,
  onAskUserCancel,
}: {
  entries: ActivityEntry[];
  active: boolean;
  lastToolKey: string | null;
  messageId: string;
  timingMaps: ReturnType<typeof buildTimingMaps>;
  workspaceRoot: string | null;
  onOpenRemoteFile: (path: string) => void;
  runId: string | null;
  askUserDrafts: Record<string, AskUserDraft>;
  onAskUserDraftChange: (runId: string, draft: AskUserDraft) => void;
  onAskUserSubmit: (runId: string, answer: AskUserAnswer) => void;
  onAskUserCancel: (runId: string) => void;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const prevActive = useRef(active);
  useEffect(() => {
    if (prevActive.current !== active) {
      prevActive.current = active;
      setOverride(null);
    }
  }, [active]);
  const open = override ?? active;
  const totalMs = groupDuration(entries, timingMaps);
  return (
    <Collapsible open={open} onOpenChange={setOverride} className="not-prose w-full">
      <CollapsibleTrigger className="flex h-6 w-full items-center gap-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        <Workflow className="size-4 shrink-0" />
        <span className="min-w-0 truncate">过程 · {entries.length} 项</span>
        {totalMs !== undefined && <span className="shrink-0 text-xs font-normal">{formatDuration(totalMs)}</span>}
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-3 flex w-[calc(100%-0.75rem)] min-w-0 flex-col gap-1 border-l border-border/60 pl-3">
        {entries.map(({ part, index }, entryIndex) => {
          const askUserState = askUserStateForQuestion(entries.map((entry) => entry.part), entryIndex);
          return (
            <AssistantPart
              key={index}
              part={part}
              answer={askUserState.answer}
              canceled={askUserState.canceled}
              toolActive={`${messageId}:${index}` === lastToolKey}
              timingMaps={timingMaps}
              workspaceRoot={workspaceRoot}
              onOpenRemoteFile={onOpenRemoteFile}
              runId={runId}
              askUserDrafts={askUserDrafts}
              onAskUserDraftChange={onAskUserDraftChange}
              onAskUserSubmit={onAskUserSubmit}
              onAskUserCancel={onAskUserCancel}
            />
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

function userText(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function runIdFromAssistant(message: UIMessage | undefined): string | null {
  if (!message || message.role !== 'assistant') return null;
  const part = message.parts.find((p) => p.type === 'data-run-id') as { data?: { runId?: string } } | undefined;
  return part?.data?.runId ?? null;
}

function runIdForUser(messages: UIMessage[], index: number): string | null {
  const fromId = messages[index]?.id?.endsWith(':u') ? messages[index].id.slice(0, -2) : null;
  return fromId || runIdFromAssistant(messages[index + 1]);
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(size?: number): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function parseFileTokens(text: string): { text: string; files: FileToken[] } {
  const files: FileToken[] = [];
  let clean = '';
  let lastIndex = 0;
  const tokenRe = /\[\[file:(\{.*?\})\]\]/g;

  for (const match of text.matchAll(tokenRe)) {
    clean += text.slice(lastIndex, match.index);
    lastIndex = (match.index ?? 0) + match[0].length;
    try {
      const data = JSON.parse(match[1]) as Partial<FileToken>;
      if (typeof data.path === 'string' && data.path.trim()) files.push(data as FileToken);
      else clean += match[0];
    } catch {
      clean += match[0];
    }
  }
  clean += text.slice(lastIndex);

  return { text: clean.replace(/\n{3,}/g, '\n\n').trimEnd(), files };
}

function compactTocText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 360 ? `${compact.slice(0, 360)}...` : compact;
}

function userTocTitle(message: UIMessage): string {
  const parsed = parseFileTokens(userText(message));
  return compactTocText(parsed.text || parsed.files[0]?.name || parsed.files[0]?.path || '对话');
}

function UserMessageText({ message, onOpenRemoteFile }: { message: UIMessage; onOpenRemoteFile: (path: string) => void }) {
  const parsed = parseFileTokens(userText(message));
  return (
    <div className="space-y-2">
      {parsed.text && <div className="whitespace-pre-wrap">{parsed.text}</div>}
      {parsed.files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {parsed.files.map((file, index) => (
            <button
              key={`${file.path}:${index}`}
              type="button"
              onClick={() => onOpenRemoteFile(file.path)}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              title={file.path}
            >
              <FileText className="size-3" />
              <span className="truncate">{file.name || file.path}</span>
              {file.size != null && <span className="shrink-0">· {formatBytes(file.size)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMessageFooter({ message, runId }: { message: UIMessage; runId: string | null }) {
  const text = userText(message);
  const time = messageTime(message);
  const [copiedText, markCopiedText] = useCopyFeedback();
  return (
    <div className="ml-auto flex min-h-6 items-center justify-end gap-2 pr-1">
      {time && <span className="text-[11px] tabular-nums text-muted-foreground">{time}</span>}
      <MessageActions className="justify-end opacity-70 transition-opacity group-hover:opacity-100">
        <MessageAction
          tooltip={copiedText ? '已复制' : '复制消息文本'}
          label="复制消息文本"
          onClick={async () => {
            if (await copyToClipboard(text)) markCopiedText();
          }}
        >
          {copiedText ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
        </MessageAction>
        <CopyRunButton runId={runId} />
      </MessageActions>
    </div>
  );
}

function AssistantMessage({
  message,
  active,
  lastToolKey,
  lastActivityKey,
  workspaceRoot,
  onOpenRemoteFile,
  askUserDrafts,
  onAskUserDraftChange,
  onAskUserSubmit,
  onAskUserCancel,
}: {
  message: UIMessage;
  active: boolean;
  lastToolKey: string | null;
  lastActivityKey: string | null;
  workspaceRoot: string | null;
  onOpenRemoteFile: (path: string) => void;
  askUserDrafts: Record<string, AskUserDraft>;
  onAskUserDraftChange: (runId: string, draft: AskUserDraft) => void;
  onAskUserSubmit: (runId: string, answer: AskUserAnswer) => void;
  onAskUserCancel: (runId: string) => void;
}) {
  const timingMaps = buildTimingMaps(message.parts);
  const runId = runIdFromAssistant(message);
  const finalIndex = finalTextIndex(message.parts);
  const nodes: JSX.Element[] = [];
  let group: { entries: ActivityEntry[]; start: number } | null = null;
  const flushGroup = () => {
    if (!group) return;
    const active = group.entries.some((entry) => `${message.id}:${entry.index}` === lastActivityKey);
    nodes.push(
      <ActivityGroup
        key={`activity-${group.start}`}
        entries={group.entries}
        active={active}
        lastToolKey={lastToolKey}
        messageId={message.id}
        timingMaps={timingMaps}
        workspaceRoot={workspaceRoot}
        onOpenRemoteFile={onOpenRemoteFile}
        runId={runId}
        askUserDrafts={askUserDrafts}
        onAskUserDraftChange={onAskUserDraftChange}
        onAskUserSubmit={onAskUserSubmit}
        onAskUserCancel={onAskUserCancel}
      />,
    );
    group = null;
  };

  message.parts.forEach((part, i) => {
    if (isHiddenDataPart(part)) return;
    if (finalIndex != null && i < finalIndex) {
      group ??= { entries: [], start: i };
      group.entries.push({ part, index: i });
      return;
    }
    if (isActivityPart(part)) {
      group ??= { entries: [], start: i };
      group.entries.push({ part, index: i });
      return;
    }
    flushGroup();
    const askUserState = askUserStateForQuestion(message.parts, i);
    nodes.push(
      <AssistantPart
        key={i}
        part={part}
        answer={askUserState.answer}
        canceled={askUserState.canceled}
        toolActive={`${message.id}:${i}` === lastToolKey}
        timingMaps={timingMaps}
        workspaceRoot={workspaceRoot}
        onOpenRemoteFile={onOpenRemoteFile}
        runId={runId}
        askUserDrafts={askUserDrafts}
        onAskUserDraftChange={onAskUserDraftChange}
        onAskUserSubmit={onAskUserSubmit}
        onAskUserCancel={onAskUserCancel}
      />,
    );
  });
  flushGroup();
  return (
    <>
      {nodes}
      <StreamStatusBar parts={message.parts} active={active} time={messageTime(message)} runId={runId} />
    </>
  );
}

export function Conversation({
  messages,
  busy,
  wide,
  workspaceRoot,
  onOpenRemoteFile,
  askUserDrafts,
  onAskUserDraftChange,
  onAskUserSubmit,
  onAskUserCancel,
  contentRef,
  embedded = false,
  showToc = true,
  emptyTitle = 'my-agent',
  emptyDescription = '通用 AI Agent。描述一个任务，它会自主调用工具（shell、文件、glob/grep、web）逐步完成。',
}: {
  messages: UIMessage[];
  busy: boolean;
  wide: boolean;
  workspaceRoot: string | null;
  contentRef: RefObject<HTMLDivElement | null>;
  onOpenRemoteFile: (path: string) => void;
  askUserDrafts: Record<string, AskUserDraft>;
  onAskUserDraftChange: (runId: string, draft: AskUserDraft) => void;
  onAskUserSubmit: (runId: string, answer: AskUserAnswer) => void;
  onAskUserCancel: (runId: string) => void;
  embedded?: boolean;
  showToc?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  // 记录整段对话里最后一个工具调用，只保持它展开，其余默认折叠。
  let lastToolKey: string | null = null;
  let lastActivityKey: string | null = null;
  let activeAssistantId: string | null = null;
  if (busy) {
    for (const m of messages) {
      if (m.role === 'user') continue;
      activeAssistantId = m.id;
      m.parts.forEach((part, i) => {
        if (isToolPart(part)) lastToolKey = `${m.id}:${i}`;
        if (isActivityPart(part)) lastActivityKey = `${m.id}:${i}`;
      });
    }
  }
  return (
    <div className="relative flex h-full min-h-0 justify-center">
      <div className={cn('flex h-full min-h-0 w-full min-w-0', embedded ? 'max-w-none' : wide ? 'max-w-[calc(64rem+1.75rem)]' : 'max-w-[calc(48rem+1.75rem)]')}>
      <AIConversation className="min-h-0 min-w-0 flex-1">
        <ConversationContent>
          <div ref={contentRef as RefObject<HTMLDivElement>} className={cn('flex flex-col', embedded ? 'gap-4 px-3 py-4' : 'gap-8')}>
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<Bot className="size-6" />}
                title={emptyTitle}
                description={emptyDescription}
              />
            ) : (
              messages.map((m, index) => (
                <Message
                  from={m.role}
                  key={m.id}
                  data-toc-message={m.role === 'user' ? 'user' : undefined}
                  data-toc-title={m.role === 'user' ? userTocTitle(m) : undefined}
                  data-toc-time={m.role === 'user' ? messageTime(m) ?? undefined : undefined}
                >
                  {m.role === 'user' ? (
                    <>
                      <MessageContent>
                        <UserMessageText message={m} onOpenRemoteFile={onOpenRemoteFile} />
                      </MessageContent>
                      <UserMessageFooter message={m} runId={runIdForUser(messages, index)} />
                    </>
                  ) : (
                    <>
                      <MessageContent>
                        <AssistantMessage
                          message={m}
                          active={busy && m.id === activeAssistantId}
                          lastToolKey={lastToolKey}
                          lastActivityKey={lastActivityKey}
                          workspaceRoot={workspaceRoot}
                          onOpenRemoteFile={onOpenRemoteFile}
                          askUserDrafts={askUserDrafts}
                          onAskUserDraftChange={onAskUserDraftChange}
                          onAskUserSubmit={onAskUserSubmit}
                          onAskUserCancel={onAskUserCancel}
                        />
                      </MessageContent>
                    </>
                  )}
                </Message>
              ))
            )}
            {busy && messages[messages.length - 1]?.role === 'user' && (
              <div className="flex items-center gap-2 pl-1 text-sm text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-primary" />
                正在思考…
              </div>
            )}
          </div>
        </ConversationContent>
        <ConversationScrollButton className="left-[calc(50%-0.875rem)]" />
      </AIConversation>
      {showToc && <TableOfContents contentRef={contentRef} />}
      </div>
    </div>
  );
}
