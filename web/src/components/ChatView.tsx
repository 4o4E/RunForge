import type { UIMessage } from 'ai';
import type { RefObject } from 'react';
import { Conversation, latestUsageSnapshot } from './Conversation';
import { Composer, type ComposerAttachment } from './Composer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bell, BellOff, Gauge, Maximize2, Menu, Minimize2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { AskUserAnswer } from '@/api';
import type { AskUserDraft } from './AskUserCard';
import { AgentStatusCard } from './StatusCard';
import { TableOfContents } from './TableOfContents';
import { cn } from '@/lib/utils';
import type { LlmModelOption } from '@/api';

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
  modelOptions: LlmModelOption[];
  selectedModelRef: string;
  editingRunId: string | null;
  onDraftChange: (text: string) => void;
  onModelChange: (modelRef: string) => void;
  onSend: (text: string, modelRef: string) => void;
  onCancel: () => void;
  onCancelEdit: () => void;
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
  onOpenThread: (threadId: string) => void;
  onAskUserDraftChange: (runId: string, draft: AskUserDraft) => void;
  onAskUserSubmit: (runId: string, answer: AskUserAnswer) => void;
  onAskUserCancel: (runId: string) => void;
  onSwitchRunBranch: (runId: string) => void;
  onEditRunInput: (runId: string, currentText: string) => void;
  onForkFromRun: (runId: string) => void;
  mobile?: boolean;
  notificationBusy?: boolean;
  notificationError?: string | null;
  notificationState?: 'unsupported' | 'default' | 'denied' | 'enabled' | 'disabled';
  onOpenMobileSidebar?: () => void;
  onTogglePushNotifications?: () => void;
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
  modelOptions,
  selectedModelRef,
  editingRunId,
  onDraftChange,
  onModelChange,
  onSend,
  onCancel,
  onCancelEdit,
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
  onOpenThread,
  onAskUserDraftChange,
  onAskUserSubmit,
  onAskUserCancel,
  onSwitchRunBranch,
  onEditRunInput,
  onForkFromRun,
  mobile = false,
  notificationBusy = false,
  notificationError = null,
  notificationState = 'unsupported',
  onOpenMobileSidebar,
  onTogglePushNotifications,
}: Props) {
  const showStatusCard = mobile ? statusCardOpen : rightPanelOpen ? statusCardOpen : !statusCardOpen;
  const usage = latestUsageFromMessages(messages);
  const renderStatusCard = () => (
    <AgentStatusCard
      messages={messages}
      busy={busy}
      threadId={threadId}
      onOpenShellPreview={onOpenShellPreview}
      onOpenSubagentPreview={onOpenSubagentPreview}
      className="w-full min-w-0 max-w-none"
    />
  );
  const notificationTitle =
    notificationState === 'enabled'
      ? '关闭后台通知'
      : notificationState === 'denied'
        ? '浏览器已拒绝通知，请在浏览器设置中开启'
        : notificationState === 'unsupported'
          ? notificationError ?? '当前浏览器不支持后台通知；移动端请使用 HTTPS'
          : '开启后台通知';
  return (
    <main className="app-main-surface relative flex h-full min-w-0 flex-1 flex-col">
      <header className="app-topbar-surface flex h-14 shrink-0 items-center border-b px-3 sm:px-6">
        {mobile && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mr-1 size-9 shrink-0"
            onClick={onOpenMobileSidebar}
            title="打开会话列表"
          >
            <Menu className="size-4" />
          </Button>
        )}
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <Badge variant={busy ? 'default' : 'secondary'} className="ml-3">
          {busy ? '运行中' : '空闲'}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant={notificationState === 'enabled' ? 'secondary' : 'ghost'}
            size="icon"
            className="size-9"
            onClick={onTogglePushNotifications}
            disabled={notificationBusy}
            title={notificationTitle}
          >
            {notificationState === 'enabled' ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          </Button>
          <Button
            type="button"
            variant={showStatusCard ? 'secondary' : 'ghost'}
            size="icon"
            className="size-9"
            onClick={onToggleStatusCard}
            title={showStatusCard ? '关闭状态卡片' : '打开状态卡片'}
          >
            <Gauge className="size-4" />
          </Button>
          <Button
            type="button"
            variant={wide ? 'secondary' : 'ghost'}
            size="icon"
            className="hidden size-9 md:inline-flex"
            onClick={onToggleWide}
            title={wide ? '恢复正常宽度' : '加宽对话'}
          >
            {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
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
        <div className={cn('shrink-0 border-b px-3 py-2', !rightPanelOpen && '2xl:hidden')}>
          {renderStatusCard()}
        </div>
      )}

      {!rightPanelOpen && (
        <div className="pointer-events-none absolute bottom-28 right-6 top-16 z-30 hidden min-h-0 w-72 flex-col gap-3 2xl:flex">
          {showStatusCard && <div className="pointer-events-auto">{renderStatusCard()}</div>}
          <TableOfContents contentRef={contentRef} floating={false} />
        </div>
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
          onOpenThread={onOpenThread}
          onAskUserDraftChange={onAskUserDraftChange}
          onAskUserSubmit={onAskUserSubmit}
          onAskUserCancel={onAskUserCancel}
          onSwitchRunBranch={onSwitchRunBranch}
          onEditRunInput={onEditRunInput}
          onForkFromRun={onForkFromRun}
          showToc={false}
        />
      </div>

      <Composer
        disabled={busy || !!waitingQuestion}
        waitingQuestion={waitingQuestion}
        draft={draft}
        wide={wide}
        attachments={attachments}
        usage={usage}
        modelOptions={modelOptions}
        selectedModelRef={selectedModelRef}
        editingRunId={editingRunId}
        onDraftChange={onDraftChange}
        onModelChange={onModelChange}
        onSend={onSend}
        onCancel={onCancel}
        onCancelEdit={onCancelEdit}
        onRemoveAttachment={onRemoveAttachment}
        onOpenRemoteFiles={onOpenRemoteFiles}
        onUploadLocal={onUploadLocal}
      />
    </main>
  );
}
