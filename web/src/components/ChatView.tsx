import type { UIMessage } from 'ai';
import type { RefObject } from 'react';
import { Conversation, latestUsageSnapshot } from './Conversation';
import { Composer, type ComposerAttachment } from './Composer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Gauge, PanelRightClose, PanelRightOpen, Square } from 'lucide-react';
import type { AskUserAnswer } from '@/api';
import type { AskUserDraft } from './AskUserCard';
import { AgentStatusCard } from './StatusCard';

function latestUsageFromMessages(messages: UIMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = latestUsageSnapshot(messages[i].parts);
    if (usage) return usage;
  }
  return null;
}

interface Props {
  title: string;
  messages: UIMessage[];
  busy: boolean;
  waitingQuestion: string | null;
  draft: string;
  wide: boolean;
  workspaceRoot: string | null;
  threadId: string | null;
  contentRef: RefObject<HTMLDivElement | null>;
  askUserDrafts: Record<string, AskUserDraft>;
  attachments: ComposerAttachment[];
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onToggleWide: () => void;
  onRemoveAttachment: (path: string) => void;
  rightPanelOpen: boolean;
  statusCardOpen: boolean;
  onToggleStatusCard: () => void;
  onToggleRightPanel: () => void;
  onOpenShellPreview: (sessionId: string) => void;
  onOpenSubagentPreview: (subagentId: string) => void;
  onOpenRemoteFiles: () => void;
  onUploadLocal: (file: File, path: string) => Promise<void>;
  onOpenRemoteFile: (path: string) => void;
  onAskUserDraftChange: (runId: string, draft: AskUserDraft) => void;
  onAskUserSubmit: (runId: string, answer: AskUserAnswer) => void;
  onAskUserCancel: (runId: string) => void;
}

export function ChatView({
  title,
  messages,
  busy,
  waitingQuestion,
  draft,
  wide,
  workspaceRoot,
  threadId,
  contentRef,
  askUserDrafts,
  attachments,
  onDraftChange,
  onSend,
  onCancel,
  onToggleWide,
  onRemoveAttachment,
  rightPanelOpen,
  statusCardOpen,
  onToggleStatusCard,
  onToggleRightPanel,
  onOpenShellPreview,
  onOpenSubagentPreview,
  onOpenRemoteFiles,
  onUploadLocal,
  onOpenRemoteFile,
  onAskUserDraftChange,
  onAskUserSubmit,
  onAskUserCancel,
}: Props) {
  const showStatusCard = !rightPanelOpen || statusCardOpen;
  const usage = latestUsageFromMessages(messages);
  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center border-b bg-card px-6">
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <Badge variant={busy ? 'default' : 'secondary'} className="ml-3">
          {busy ? '运行中' : '空闲'}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          {busy && (
            <Button type="button" variant="outline" size="sm" onClick={onCancel} title="终止当前对话">
              <Square className="size-3.5" />
              终止
            </Button>
          )}
          <Button
            type="button"
            variant={showStatusCard ? 'secondary' : 'ghost'}
            size="sm"
            onClick={rightPanelOpen ? onToggleStatusCard : undefined}
            title={rightPanelOpen ? (showStatusCard ? '关闭状态卡片' : '打开状态卡片') : '状态卡片已显示'}
          >
            <Gauge className="size-4" />
            状态
          </Button>
          <Button
            type="button"
            variant={rightPanelOpen ? 'secondary' : 'ghost'}
            size="icon"
            className="size-9"
            onClick={onToggleRightPanel}
            title={rightPanelOpen ? '收起右侧栏' : '展开右侧栏'}
          >
            {rightPanelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </Button>
        </div>
      </header>

      {showStatusCard && (
        <AgentStatusCard
          messages={messages}
          busy={busy}
          threadId={threadId}
          onOpenShellPreview={onOpenShellPreview}
          onOpenSubagentPreview={onOpenSubagentPreview}
          className={wide
            ? 'absolute right-6 top-16 z-30 min-w-72 max-w-[calc(100vw-3rem)] xl:left-[calc(50%+33rem)] xl:w-auto xl:max-w-none'
            : 'absolute right-6 top-16 z-30 min-w-72 max-w-[calc(100vw-3rem)] xl:left-[calc(50%+25rem)] xl:w-auto xl:max-w-none'}
        />
      )}

      <div className="min-h-0 flex-1">
        <Conversation
          messages={messages}
          busy={busy}
          wide={wide}
          workspaceRoot={workspaceRoot}
          contentRef={contentRef}
          askUserDrafts={askUserDrafts}
          onOpenRemoteFile={onOpenRemoteFile}
          onAskUserDraftChange={onAskUserDraftChange}
          onAskUserSubmit={onAskUserSubmit}
          onAskUserCancel={onAskUserCancel}
        />
      </div>

      <Composer
        disabled={busy || !!waitingQuestion}
        waitingQuestion={waitingQuestion}
        draft={draft}
        wide={wide}
        attachments={attachments}
        usage={usage}
        onDraftChange={onDraftChange}
        onSend={onSend}
        onCancel={onCancel}
        onToggleWide={onToggleWide}
        onRemoveAttachment={onRemoveAttachment}
        onOpenRemoteFiles={onOpenRemoteFiles}
        onUploadLocal={onUploadLocal}
      />
    </main>
  );
}
