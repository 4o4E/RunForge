import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../api';
import { MarkdownContent } from './MarkdownContent';

export interface Turn {
  input: string;
  events: AgentEvent[];
  running: boolean;
}

function toolInput(args: unknown): string {
  // Show the shell command directly; otherwise pretty-print the args object.
  if (args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string') {
    return (args as { command: string }).command;
  }
  return JSON.stringify(args, null, 2);
}

// Combined tool card: input (call) and output (result) joined in one block.
function ToolCard({ name, args, result }: { name: string; args: unknown; result?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-surface-500">
      <div className="flex items-center gap-1.5 border-b border-surface-400 bg-amber-50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-surface-800 dark:bg-amber-500/10">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
        🔧 {name}
      </div>
      <div className="px-3 py-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-surface-700">输入</div>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-surface-900">
          {toolInput(args)}
        </pre>
      </div>
      {result !== undefined ? (
        <div className="border-t border-surface-400 bg-surface-300 px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-surface-700">输出</div>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-surface-900">
            {result.slice(0, 8000)}
          </pre>
        </div>
      ) : (
        <div className="border-t border-surface-400 bg-surface-300 px-3 py-1.5 text-[11px] text-surface-700">
          运行中…
        </div>
      )}
    </div>
  );
}

function ReasoningCard({ text }: { text: string }) {
  return (
    <details className="group rounded-lg border border-surface-500 bg-surface-100" open>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-surface-800">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-purple-400" />
        思考
        <span className="ml-auto text-surface-700 transition group-open:rotate-90">›</span>
      </summary>
      <div className="border-t border-surface-400 px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-sans text-xs italic leading-relaxed text-surface-800">
          {text}
        </pre>
      </div>
    </details>
  );
}

function AssistantBubble({ text, final }: { text: string; final?: boolean }) {
  const tone = final
    ? 'bg-primary-50 ring-primary-200 dark:bg-primary-500/15 dark:ring-primary-500/30'
    : 'bg-surface-50 ring-surface-400';
  return (
    <div className={`max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm ring-1 ${tone}`}>
      <MarkdownContent text={text} />
    </div>
  );
}

// Block model: aggregate consecutive llm_delta / reasoning (streaming chunks) into
// single blocks, preserving order; `final` is a completion marker, not a 2nd bubble.
type ToolBlock = { kind: 'tool'; id: string; name: string; args: unknown; result?: string };
type Block =
  | { kind: 'reasoning'; text: string }
  | { kind: 'assistant'; text: string; final?: boolean }
  | ToolBlock
  | { kind: 'error'; message: string };

function buildBlocks(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  const toolById = new Map<string, ToolBlock>();
  let textBuf = '';
  let reasonBuf = '';
  let hasAssistant = false;

  const flushReason = () => {
    if (reasonBuf) {
      blocks.push({ kind: 'reasoning', text: reasonBuf });
      reasonBuf = '';
    }
  };
  const flushText = () => {
    if (textBuf) {
      blocks.push({ kind: 'assistant', text: textBuf });
      textBuf = '';
      hasAssistant = true;
    }
  };

  for (const e of events) {
    switch (e.type) {
      case 'step_start':
        break;
      case 'reasoning':
        flushText();
        reasonBuf += e.text;
        break;
      case 'llm_delta':
        flushReason();
        textBuf += e.text;
        break;
      case 'tool_call': {
        flushReason();
        flushText();
        const block: ToolBlock = { kind: 'tool', id: e.id, name: e.name, args: e.args };
        toolById.set(e.id, block);
        blocks.push(block); // result is attached in place when it arrives
        break;
      }
      case 'tool_result': {
        const block = toolById.get(e.id);
        if (block) block.result = e.result;
        else blocks.push({ kind: 'tool', id: e.id, name: e.name, args: undefined, result: e.result });
        break;
      }
      case 'final':
        flushReason();
        if (textBuf || hasAssistant) flushText(); // already shown via llm_delta
        else blocks.push({ kind: 'assistant', text: e.output, final: true });
        break;
      case 'error':
        flushReason();
        flushText();
        blocks.push({ kind: 'error', message: e.message });
        break;
    }
  }
  flushReason();
  flushText();
  return blocks;
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'reasoning':
      return <ReasoningCard text={b.text} />;
    case 'assistant':
      return <AssistantBubble text={b.text} final={b.final} />;
    case 'tool':
      return <ToolCard name={b.name} args={b.args} result={b.result} />;
    case 'error':
      return (
        <div className="max-w-[85%] rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30">
          {b.message}
        </div>
      );
  }
}

// Short one-line summary shown in a step header when the step is collapsed.
function stepSummary(blocks: Block[]): string {
  const tools = blocks.filter((b): b is ToolBlock => b.kind === 'tool');
  if (tools.length) return '🔧 ' + tools.map((t) => t.name).join(', ');
  const assistant = blocks.find((b): b is Extract<Block, { kind: 'assistant' }> => b.kind === 'assistant');
  if (assistant) return assistant.text.replace(/[#*`>_]/g, '').trim().slice(0, 48) || '回答';
  if (blocks.some((b) => b.kind === 'reasoning')) return '思考';
  if (blocks.some((b) => b.kind === 'error')) return '错误';
  return '';
}

function StepGroup({
  step,
  events,
  open,
  onToggle,
}: {
  step: number;
  events: AgentEvent[];
  open: boolean;
  onToggle: () => void;
}) {
  const blocks = buildBlocks(events);
  if (blocks.length === 0) return null;
  return (
    <div className="border-l-2 border-surface-400 pl-3">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-surface-700 transition hover:text-surface-900"
      >
        <span className={`transition ${open ? 'rotate-90' : ''}`}>›</span>
        <span>step {step}</span>
        {!open && <span className="truncate font-normal normal-case tracking-normal text-surface-700">· {stepSummary(blocks)}</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {blocks.map((b, i) => (
            <BlockView key={i} b={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const groups = new Map<number, AgentEvent[]>();
  for (const e of turn.events) {
    const arr = groups.get(e.step) ?? [];
    arr.push(e);
    groups.set(e.step, arr);
  }
  const steps = [...groups.keys()].sort((a, b) => a - b);
  const lastStep = steps[steps.length - 1];

  // Latest step is expanded by default; once a newer step appears the previous one
  // auto-collapses. A manual toggle overrides the default for that step.
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const isOpen = (s: number) => overrides[s] ?? s === lastStep;
  const toggle = (s: number) => setOverrides((o) => ({ ...o, [s]: !isOpen(s) }));

  return (
    <div className="animate-fade-in-up space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary-500 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
          {turn.input}
        </div>
      </div>
      <div className="space-y-2">
        {steps.map((s) => (
          <StepGroup key={s} step={s} events={groups.get(s)!} open={isOpen(s)} onToggle={() => toggle(s)} />
        ))}
        {turn.running && (
          <div className="flex items-center gap-2 pl-3 text-sm text-surface-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary-500" />
            正在思考…
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageList({ turns }: { turns: Turn[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-500 text-2xl text-white shadow-panel">
          🤖
        </div>
        <h2 className="text-lg font-semibold text-surface-950">my-agent</h2>
        <p className="max-w-sm text-sm text-surface-800">
          通用 AI Agent。描述一个任务，它会自主调用工具（shell、文件、glob/grep、web）逐步完成。
        </p>
      </div>
    );
  }

  return (
    <div ref={ref} className="scrollbar-thin h-full space-y-6 overflow-y-auto px-6 py-6">
      {turns.map((t, i) => (
        <TurnView key={i} turn={t} />
      ))}
    </div>
  );
}
