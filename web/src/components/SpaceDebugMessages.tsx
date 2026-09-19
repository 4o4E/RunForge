import { useEffect, useState, type ReactNode } from 'react';
import type {
  SpaceDebugMcpSchema,
  SpaceDebugMcpServer,
  SpaceDebugSkill,
  SpaceDebugTool,
  SpaceDebugView,
  StepContextMessage,
  StepContextSnapshotSummary,
  StepContextSnapshotView,
} from '@runforge/contracts';
import { ChevronDown } from 'lucide-react';
import { getSpaceDebugMcpSchema, getSpaceDebugView } from '@/api';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { cn } from '@/lib/utils';
import { useStepContextDebug } from '@/components/StepContextDebug';

function ToolSchema({ tool }: { tool: SpaceDebugTool }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border bg-background">
      <CollapsibleTrigger className="flex w-full items-start gap-2 px-3 py-2 text-left">
        <ChevronDown className={cn('mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        <span className="min-w-0">
          <span className="block break-all font-mono text-xs font-medium text-foreground">{tool.name}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{tool.description}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {JSON.stringify(tool.parameters, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DebugMessage({ children }: { children: ReactNode }) {
  return (
    <Message from="assistant">
      <MessageContent>{children}</MessageContent>
    </Message>
  );
}

function DebugSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DebugMessage>
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-muted/10">
        <CollapsibleTrigger className="flex w-full items-start gap-2 px-3 py-2.5 text-left">
          <ChevronDown className={cn('mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-180')} />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{title}</span>
            {description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t p-3">{children}</CollapsibleContent>
      </Collapsible>
    </DebugMessage>
  );
}

function ContextMessage({ message, index }: { message: StepContextMessage; index: number }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono font-medium text-foreground">{index + 1}. {message.role}</span>
        {message.toolCallId && <span className="font-mono">toolCallId: {message.toolCallId}</span>}
        {message.collapsed && <span>{message.collapsed === 'masked' ? '已动态裁剪' : '已摘要'}</span>}
        {message.providerState && (
          <span>推理状态 {message.providerState.reasoningParts} 段 / 加密内容 {message.providerState.encryptedChars} 字符</span>
        )}
      </div>
      {message.content != null && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {message.content || '（空内容）'}
        </pre>
      )}
      {message.contentParts?.length ? (
        <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
          {message.contentParts.map((part, partIndex) => (
            <div key={`${part.type}:${partIndex}`} className="rounded bg-muted/40 px-2 py-1">
              {part.type === 'text'
                ? part.text
                : `图片 · ${part.name || part.path || '未命名'} · ${part.mimeType || '未知类型'}`}
            </div>
          ))}
        </div>
      ) : null}
      {message.toolCalls?.length ? (
        <div className="mt-2 grid gap-1">
          {message.toolCalls.map((call) => (
            <pre key={call.id} className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 font-mono text-xs">
              {`${call.name} · ${call.id}\n${call.arguments}`}
            </pre>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StepContextDetails({ context }: { context: StepContextSnapshotView }) {
  return (
    <div className="grid gap-2">
      {context.messages.map((message, index) => (
        <ContextMessage key={`${index}:${message.role}:${message.toolCallId ?? ''}`} message={message} index={index} />
      ))}
      {!context.messages.length && <div className="text-xs text-muted-foreground">该次调用没有消息。</div>}
    </div>
  );
}

function ContextSnapshotItem({ context }: { context: StepContextSnapshotSummary }) {
  const [open, setOpen] = useState(false);
  const { details, loadContext } = useStepContextDebug();
  const detail = details[context.stepId] ?? null;
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || detail) return;
    let canceled = false;
    setError('');
    void loadContext(context.stepId).catch((requestError: Error) => {
      if (!canceled) setError(requestError.message);
    });
    return () => { canceled = true; };
  }, [context.stepId, detail, loadContext, open]);
  const time = new Date(context.createdAt);
  const timeLabel = Number.isFinite(time.getTime())
    ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border bg-background">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        <span className="min-w-0 flex-1 text-xs font-medium">Step {context.step} · {context.messageCount} 条消息</span>
        <span className="shrink-0 text-xs text-muted-foreground">{context.toolCount} 个工具</span>
        {timeLabel && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeLabel}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-3">
        {error && <div className="text-xs text-destructive">读取提示词失败：{error}</div>}
        {!error && !detail && <div className="text-xs text-muted-foreground">正在读取提示词…</div>}
        {detail && <StepContextDetails context={detail} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SkillItem({ skill }: { skill: SpaceDebugSkill }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border bg-background">
      <CollapsibleTrigger className="flex w-full items-start gap-2 px-3 py-2 text-left">
        <ChevronDown className={cn('mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        <span className="min-w-0 flex-1">
          <span className="block break-all font-mono text-xs font-medium">{skill.name}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{skill.description}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {skill.content || '入口内容为空'}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function McpItem({ spaceId, server }: { spaceId: string; server: SpaceDebugMcpServer }) {
  const [open, setOpen] = useState(false);
  const [schema, setSchema] = useState<SpaceDebugMcpSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || schema) return;
    let canceled = false;
    setLoading(true);
    setError('');
    getSpaceDebugMcpSchema(spaceId, server.id)
      .then((result) => {
        if (!canceled) setSchema(result);
      })
      .catch((requestError: Error) => {
        if (!canceled) setError(requestError.message);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [open, server.id, spaceId]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border bg-background">
      <CollapsibleTrigger className="flex w-full items-start gap-2 px-3 py-2 text-left">
        <ChevronDown className={cn('mt-0.5 size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        <span className="min-w-0 flex-1">
          <span className="block break-all font-mono text-xs font-medium">{server.label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{server.description}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 border-t px-3 py-2">
        {loading && <div className="text-xs text-muted-foreground">正在读取 MCP 工具 Schema…</div>}
        {error && <div className="text-xs text-destructive">读取 MCP 工具 Schema 失败：{error}</div>}
        {schema?.tools.map((tool) => (
          <ToolSchema key={tool.name} tool={tool} />
        ))}
        {schema && !schema.tools.length && <div className="text-xs text-muted-foreground">该 MCP Server 没有提供工具。</div>}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SpaceDebugMessages({ spaceId }: { spaceId: string }) {
  const [view, setView] = useState<SpaceDebugView | null>(null);
  const [error, setError] = useState('');
  const stepContexts = useStepContextDebug();

  useEffect(() => {
    let canceled = false;
    setError('');
    getSpaceDebugView(spaceId)
      .then((result) => {
        if (!canceled) setView(result);
      })
      .catch((requestError: Error) => {
        if (!canceled) setError(requestError.message);
      });
    return () => {
      canceled = true;
    };
  }, [spaceId]);

  if (error) {
    return <DebugMessage><div className="text-sm text-destructive">读取空间调试信息失败：{error}</div></DebugMessage>;
  }
  if (!view) {
    return <DebugMessage><div className="text-sm text-muted-foreground">正在读取空间调试信息…</div></DebugMessage>;
  }

  return (
    <>
      <DebugSection title="Tool Schema" description={`${view.tools.length} 个当前空间工具 · 配置 v${view.configVersion}`}>
        {view.tools.length
          ? <div className="grid gap-2">{view.tools.map((tool) => <ToolSchema key={tool.name} tool={tool} />)}</div>
          : <div className="text-xs text-muted-foreground">当前空间没有配置工具。</div>}
      </DebugSection>

      <DebugSection title="实际提示词" description={`${stepContexts.contexts.length} 次 Agent 模型调用`}>
        {stepContexts.loading && !stepContexts.contexts.length && (
          <div className="text-xs text-muted-foreground">正在读取实际提示词…</div>
        )}
        {stepContexts.error && <div className="text-xs text-destructive">读取实际提示词失败：{stepContexts.error}</div>}
        {stepContexts.contexts.length
          ? <div className="grid gap-2">{stepContexts.contexts.map((context) => <ContextSnapshotItem key={context.stepId} context={context} />)}</div>
          : !stepContexts.loading && !stepContexts.error
            ? <div className="text-xs text-muted-foreground">当前活动分支尚未调用 Agent 模型。</div>
            : null}
      </DebugSection>

      <DebugSection title="Skill" description={`${view.skills.length} 个当前空间 Skill`}>
        {view.skills.length
          ? <div className="grid gap-2">{view.skills.map((skill) => <SkillItem key={skill.id} skill={skill} />)}</div>
          : <div className="text-xs text-muted-foreground">当前空间没有配置 Skill。</div>}
      </DebugSection>

      <DebugSection title="MCP" description={`${view.mcpServers.length} 个当前空间 MCP Server`}>
        {view.mcpServers.length
          ? <div className="grid gap-2">{view.mcpServers.map((server) => (
              <McpItem key={server.id} spaceId={spaceId} server={server} />
            ))}</div>
          : <div className="text-xs text-muted-foreground">当前空间没有配置 MCP Server。</div>}
      </DebugSection>
    </>
  );
}
