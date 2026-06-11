import type { UIMessage } from 'ai';
import { Bot, ChevronDown, Copy, Fingerprint, FileText, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Conversation as AIConversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import type { ToolUIPart } from 'ai';
import { A2uiSurface } from '@/a2ui/A2uiSurface';
import type { A2uiMessage } from '@/a2ui/types';
import { TableOfContents } from './TableOfContents';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

type Part = UIMessage['parts'][number];
type Timing = { startedAt?: string; endedAt?: string; durationMs?: number };
type ActivityEntry = { part: Part; index: number };

const PATH_RE = /(?:\/[A-Za-z0-9._~+/@:-]+|(?:\.{1,2}\/)?(?:server|web|docs|src|uploads|tests)\/[A-Za-z0-9._~+/@:-]+)/g;

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
  return p.type === 'data-run-id' || p.type === 'data-tool-timing' || p.type === 'data-reasoning-timing';
}

function durationFromTiming(t?: Timing): number | undefined {
  if (!t) return undefined;
  if (t.startedAt && t.endedAt) {
    return Math.max(0, new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime());
  }
  return t.durationMs;
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

function detectedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_RE)) {
    const path = match[0].replace(/[),.;\]]+$/, '');
    if (!path.includes('://')) found.add(path);
  }
  return [...found].slice(0, 12);
}

function PathAwareResponse({ text, onOpenRemoteFile }: { text: string; onOpenRemoteFile: (path: string) => void }) {
  const paths = detectedPaths(text);
  return (
    <div className="space-y-2">
      <MessageResponse>{text}</MessageResponse>
      {paths.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {paths.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => onOpenRemoteFile(path)}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              title={path}
            >
              <FileText className="size-3" />
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// `active` marks the most recent tool call. It stays expanded; as soon as a newer
// tool call appears the previous one auto-collapses. The user can still toggle any
// block manually (override), and the override is cleared when `active` flips so the
// block rejoins the "only the latest stays open" rule.
function ToolBlock({ part, active, timing }: { part: Part; active: boolean; timing?: Timing }) {
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
        <ToolInput input={p.input} />
        <ToolOutput output={p.output as never} errorText={p.errorText} />
      </ToolContent>
    </Tool>
  );
}

function AssistantPart({
  part,
  toolActive,
  timingMaps,
  onOpenRemoteFile,
}: {
  part: Part;
  toolActive: boolean;
  timingMaps: ReturnType<typeof buildTimingMaps>;
  onOpenRemoteFile: (path: string) => void;
}) {
  if (part.type === 'text') return part.text ? <PathAwareResponse text={part.text} onOpenRemoteFile={onOpenRemoteFile} /> : null;
  if (part.type === 'reasoning') {
    const duration = durationFromTiming(timingForPart(part, timingMaps));
    return part.text ? (
      <Reasoning isStreaming={part.state === 'streaming'} defaultOpen={part.state === 'streaming'} duration={duration ? Math.ceil(duration / 1000) : undefined}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    ) : null;
  }
  if (part.type === 'data-a2ui') {
    return <A2uiSurface message={(part as { data: A2uiMessage }).data} />;
  }
  if (isToolPart(part)) return <ToolBlock part={part} active={toolActive} timing={timingForPart(part, timingMaps)} />;
  return null;
}

function ActivityGroup({
  entries,
  active,
  lastToolKey,
  messageId,
  timingMaps,
  onOpenRemoteFile,
}: {
  entries: ActivityEntry[];
  active: boolean;
  lastToolKey: string | null;
  messageId: string;
  timingMaps: ReturnType<typeof buildTimingMaps>;
  onOpenRemoteFile: (path: string) => void;
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
    <Collapsible open={open} onOpenChange={setOverride} className="not-prose my-1 w-full">
      <CollapsibleTrigger className="inline-flex max-w-full items-center gap-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        <Workflow className="size-4 shrink-0" />
        <span className="min-w-0 truncate">过程 · {entries.length} 项</span>
        {totalMs !== undefined && <span className="shrink-0 text-xs font-normal">{formatDuration(totalMs)}</span>}
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex w-full min-w-0 flex-col gap-1">
        {entries.map(({ part, index }) => (
          <AssistantPart
            key={index}
            part={part}
            toolActive={`${messageId}:${index}` === lastToolKey}
            timingMaps={timingMaps}
            onOpenRemoteFile={onOpenRemoteFile}
          />
        ))}
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

function copyToClipboard(value: string) {
  void navigator.clipboard.writeText(value);
}

function UserMessageText({ message }: { message: UIMessage }) {
  return <div className="whitespace-pre-wrap">{userText(message)}</div>;
}

function UserMessageActions({ message, runId }: { message: UIMessage; runId: string | null }) {
  const text = userText(message);
  return (
    <MessageActions className="ml-auto justify-end pr-1 opacity-70 transition-opacity group-hover:opacity-100">
      <MessageAction tooltip="复制消息文本" label="复制消息文本" onClick={() => copyToClipboard(text)}>
        <Copy className="size-3.5" />
      </MessageAction>
      <MessageAction tooltip={runId ? '复制 run id' : '暂无 run id'} label="复制 run id" disabled={!runId} onClick={() => runId && copyToClipboard(runId)}>
        <Fingerprint className="size-3.5" />
      </MessageAction>
    </MessageActions>
  );
}

function AssistantMessage({
  message,
  lastToolKey,
  lastActivityKey,
  onOpenRemoteFile,
}: {
  message: UIMessage;
  lastToolKey: string | null;
  lastActivityKey: string | null;
  onOpenRemoteFile: (path: string) => void;
}) {
  const timingMaps = buildTimingMaps(message.parts);
  const nodes: JSX.Element[] = [];
  const a2uiParts: Array<{ part: Part; index: number }> = [];
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
        onOpenRemoteFile={onOpenRemoteFile}
      />,
    );
    group = null;
  };

  message.parts.forEach((part, i) => {
    if (isHiddenDataPart(part)) return;
    if (part.type === 'data-a2ui') {
      a2uiParts.push({ part, index: i });
      return;
    }
    if (isActivityPart(part)) {
      group ??= { entries: [], start: i };
      group.entries.push({ part, index: i });
      return;
    }
    flushGroup();
    nodes.push(
      <AssistantPart
        key={i}
        part={part}
        toolActive={`${message.id}:${i}` === lastToolKey}
        timingMaps={timingMaps}
        onOpenRemoteFile={onOpenRemoteFile}
      />,
    );
  });
  flushGroup();
  for (const { part, index } of a2uiParts) {
    nodes.push(
      <AssistantPart
        key={`a2ui-${index}`}
        part={part}
        toolActive={false}
        timingMaps={timingMaps}
        onOpenRemoteFile={onOpenRemoteFile}
      />,
    );
  }
  return <>{nodes}</>;
}

export function Conversation({
  messages,
  busy,
  wide,
  onOpenRemoteFile,
}: {
  messages: UIMessage[];
  busy: boolean;
  wide: boolean;
  onOpenRemoteFile: (path: string) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Key (msgId:partIndex) of the last tool call across the whole conversation —
  // only that one stays expanded; everything before it collapses.
  let lastToolKey: string | null = null;
  let lastActivityKey: string | null = null;
  if (busy) {
    for (const m of messages) {
      if (m.role === 'user') continue;
      m.parts.forEach((part, i) => {
        if (isToolPart(part)) lastToolKey = `${m.id}:${i}`;
        if (isActivityPart(part)) lastActivityKey = `${m.id}:${i}`;
      });
    }
  }

  return (
    <div className="relative flex h-full min-h-0">
      <AIConversation className="h-full flex-1">
        <ConversationContent className={cn('mx-auto', wide ? 'max-w-5xl' : 'max-w-3xl')}>
          <div ref={contentRef} className="flex flex-col gap-8">
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<Bot className="size-6" />}
                title="my-agent"
                description="通用 AI Agent。描述一个任务，它会自主调用工具（shell、文件、glob/grep、web）逐步完成。"
              />
            ) : (
              messages.map((m, index) => (
                <Message from={m.role} key={m.id}>
                  {m.role === 'user' ? (
                    <>
                      <MessageContent>
                        <UserMessageText message={m} />
                      </MessageContent>
                      <UserMessageActions message={m} runId={runIdForUser(messages, index)} />
                    </>
                  ) : (
                    <MessageContent>
                      <AssistantMessage message={m} lastToolKey={lastToolKey} lastActivityKey={lastActivityKey} onOpenRemoteFile={onOpenRemoteFile} />
                    </MessageContent>
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
        <ConversationScrollButton />
      </AIConversation>
      <TableOfContents contentRef={contentRef} />
    </div>
  );
}
