import type { UIMessage } from 'ai';
import { Bot } from 'lucide-react';
import {
  Conversation as AIConversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import type { ToolUIPart } from 'ai';
import { A2uiSurface } from '@/a2ui/A2uiSurface';
import type { A2uiMessage } from '@/a2ui/types';

type Part = UIMessage['parts'][number];

function isToolPart(p: Part): boolean {
  return p.type === 'dynamic-tool' || p.type.startsWith('tool-');
}

function ToolBlock({ part }: { part: Part }) {
  const p = part as {
    type: string;
    toolName?: string;
    state: ToolUIPart['state'];
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  const open = p.state !== 'output-available';
  return (
    <Tool defaultOpen={open}>
      {p.type === 'dynamic-tool' ? (
        <ToolHeader type="dynamic-tool" toolName={p.toolName ?? 'tool'} state={p.state} />
      ) : (
        <ToolHeader type={p.type as ToolUIPart['type']} state={p.state} />
      )}
      <ToolContent>
        <ToolInput input={p.input} />
        <ToolOutput output={p.output as never} errorText={p.errorText} />
      </ToolContent>
    </Tool>
  );
}

function AssistantPart({ part }: { part: Part }) {
  if (part.type === 'text') return part.text ? <MessageResponse>{part.text}</MessageResponse> : null;
  if (part.type === 'reasoning') {
    return part.text ? (
      <Reasoning isStreaming={part.state === 'streaming'} defaultOpen={part.state === 'streaming'}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    ) : null;
  }
  if (part.type === 'data-a2ui') {
    return <A2uiSurface message={(part as { data: A2uiMessage }).data} />;
  }
  if (isToolPart(part)) return <ToolBlock part={part} />;
  return null;
}

function userText(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export function Conversation({ messages, busy }: { messages: UIMessage[]; busy: boolean }) {
  return (
    <AIConversation className="h-full">
      <ConversationContent className="mx-auto max-w-3xl">
        {messages.length === 0 ? (
          <ConversationEmptyState
            icon={<Bot className="size-6" />}
            title="my-agent"
            description="通用 AI Agent。描述一个任务，它会自主调用工具（shell、文件、glob/grep、web）逐步完成。"
          />
        ) : (
          messages.map((m) => (
            <Message from={m.role} key={m.id}>
              <MessageContent>
                {m.role === 'user' ? (
                  <div className="whitespace-pre-wrap">{userText(m)}</div>
                ) : (
                  m.parts.map((part, i) => <AssistantPart key={i} part={part} />)
                )}
              </MessageContent>
            </Message>
          ))
        )}
        {busy && messages[messages.length - 1]?.role === 'user' && (
          <div className="flex items-center gap-2 pl-1 text-sm text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-primary" />
            正在思考…
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </AIConversation>
  );
}
