import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { Bot, ChevronRight, Wrench } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';
import { Card } from '@/components/ui/card';

type Part = UIMessage['parts'][number];
type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function isToolPart(p: Part): p is Part & ToolPart {
  return p.type === 'dynamic-tool' || p.type.startsWith('tool-');
}
function toolName(p: Part & ToolPart): string {
  return p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.slice('tool-'.length);
}

function toolInput(input: unknown): string {
  if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
    return (input as { command: string }).command;
  }
  return input === undefined ? '' : JSON.stringify(input, null, 2);
}

function ToolCard({ part }: { part: Part & ToolPart }) {
  const hasOutput = part.state === 'output-available' || part.output !== undefined;
  const output = part.output ?? part.errorText;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Wrench className="h-3 w-3 text-amber-500" />
        {toolName(part)}
      </div>
      <div className="px-3 py-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">输入</div>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{toolInput(part.input)}</pre>
      </div>
      {hasOutput ? (
        <div className="border-t bg-muted/30 px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">输出</div>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
            {String(output ?? '').slice(0, 8000)}
          </pre>
        </div>
      ) : (
        <div className="border-t bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">运行中…</div>
      )}
    </Card>
  );
}

function ReasoningCard({ text }: { text: string }) {
  return (
    <details className="group rounded-xl border bg-muted/30" open>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-purple-400" />
        思考
        <ChevronRight className="ml-auto h-3.5 w-3.5 transition group-open:rotate-90" />
      </summary>
      <div className="border-t px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-sans text-xs italic leading-relaxed text-muted-foreground">
          {text}
        </pre>
      </div>
    </details>
  );
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-tl-sm border bg-card px-4 py-2.5 shadow-sm">
      <MarkdownContent text={text} />
    </div>
  );
}

function PartView({ part }: { part: Part }) {
  if (part.type === 'text') return part.text ? <AssistantBubble text={part.text} /> : null;
  if (part.type === 'reasoning') return part.text ? <ReasoningCard text={part.text} /> : null;
  if (isToolPart(part)) return <ToolCard part={part} />;
  return null;
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
        {text}
      </div>
    </div>
  );
}

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    const text = message.parts
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    return <UserBubble text={text} />;
  }
  return (
    <div className="space-y-2">
      {message.parts.map((p, i) => (
        <PartView key={i} part={p} />
      ))}
    </div>
  );
}

export function Conversation({ messages, busy }: { messages: UIMessage[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-panel">
          <Bot className="h-7 w-7" />
        </div>
        <h2 className="text-lg font-semibold">my-agent</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          通用 AI Agent。描述一个任务，它会自主调用工具（shell、文件、glob/grep、web）逐步完成。
        </p>
      </div>
    );
  }

  return (
    <div ref={ref} className="scrollbar-thin h-full space-y-6 overflow-y-auto px-6 py-6">
      {messages.map((m) => (
        <div key={m.id} className="animate-fade-in-up space-y-3">
          <MessageView message={m} />
        </div>
      ))}
      {busy && (
        <div className="flex items-center gap-2 pl-1 text-sm text-muted-foreground">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          正在思考…
        </div>
      )}
    </div>
  );
}
