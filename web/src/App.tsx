import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import { deleteThread, getRemoteFileInfo, getThread, listThreads, uploadLocalFile, type Thread } from './api';
import { createAiSdkChatTransport, type ChatThreadHandle } from './transport/aiSdkChat';
import { runsToUiMessages } from './history';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { RemoteFilesPanel } from './components/RemoteFilesPanel';
import { SettingsView } from './components/SettingsView';
import type { ComposerAttachment } from './components/Composer';
import { buildChatPath, currentBrowserPath, readChatRoute, type ChatRoute } from './router';
import { useThemeCtx } from './theme';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      resolve(value.includes(',') ? value.split(',')[1] : value);
    };
    reader.readAsDataURL(file);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function beginHorizontalResize(
  event: ReactPointerEvent,
  options: { width: number; min: number; max: number; direction: 1 | -1; onChange: (width: number) => void },
) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = options.width;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMove = (moveEvent: PointerEvent) => {
    const delta = (moveEvent.clientX - startX) * options.direction;
    options.onChange(clamp(startWidth + delta, options.min, options.max));
  };
  const onUp = () => {
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}

function attachmentToken(att: ComposerAttachment): string {
  const payload = {
    kind: att.kind,
    path: att.path,
    name: att.name,
    ...(att.size != null ? { size: att.size } : {}),
  };
  return `[[file:${JSON.stringify(payload)}]]`;
}

export function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [route, setRoute] = useState<ChatRoute>(() => readChatRoute());
  const [activeView, setActiveView] = useState<'chat' | 'settings'>(() =>
    window.location.pathname === '/settings' ? 'settings' : 'chat',
  );
  const [draft, setDraft] = useState(route.draft);
  const [wide, setWide] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [filesPanelWidth, setFilesPanelWidth] = useState(720);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const { theme, toggle: toggleTheme } = useThemeCtx();
  const activeThreadId = route.threadId;

  // 活跃会话 ID 放在 ref 中，稳定的 transport 可以读取和更新它，
  // 不需要在每次选择会话时重新创建 transport。
  const threadIdRef = useRef<string | null>(null);
  const skipNextHistoryLoadRef = useRef<string | null>(null);
  threadIdRef.current = activeThreadId;

  const refreshThreads = useCallback(() => {
    listThreads().then(setThreads).catch(() => {});
  }, []);
  useEffect(refreshThreads, [refreshThreads]);

  const refreshWorkspaceRoot = useCallback(() => {
    getRemoteFileInfo().then((info) => setWorkspaceRoot(info.workspaceRoot)).catch(() => setWorkspaceRoot(null));
  }, []);
  useEffect(refreshWorkspaceRoot, [refreshWorkspaceRoot]);

  const navigateChatRoute = useCallback((next: ChatRoute, mode: 'push' | 'replace' = 'push') => {
    const path = buildChatPath(next);
    if (currentBrowserPath() !== path) {
      if (mode === 'replace') window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    setRoute(next);
    setDraft(next.draft);
    setActiveView('chat');
  }, []);

  const navigateSettings = useCallback(() => {
    if (currentBrowserPath() !== '/settings') window.history.pushState(null, '', '/settings');
    setActiveView('settings');
  }, []);

  const handle = useMemo<ChatThreadHandle>(
    () => ({
      getThreadId: () => threadIdRef.current,
      setThreadId: (id) => {
        skipNextHistoryLoadRef.current = id;
        navigateChatRoute({ draft: '', threadId: id }, 'replace');
      },
      onThreadCreated: () => refreshThreads(),
    }),
    [navigateChatRoute, refreshThreads],
  );

  const transport = useMemo(() => createAiSdkChatTransport(handle), [handle]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({ transport });
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    const path = buildChatPath(route);
    if (activeView === 'settings') {
      if (currentBrowserPath() !== '/settings') window.history.replaceState(null, '', '/settings');
      return;
    }
    if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
    // 仅首屏规范化旧地址或根路径，后续导航由 navigateChatRoute 负责。
  }, []);

  useEffect(() => {
    const onPopState = () => {
      stop();
      setActiveView(window.location.pathname === '/settings' ? 'settings' : 'chat');
      const next = readChatRoute();
      setRoute(next);
      setDraft(next.draft);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [stop]);

  useEffect(() => {
    let canceled = false;

    if (!activeThreadId) {
      setMessages([]);
      return () => {
        canceled = true;
      };
    }

    if (skipNextHistoryLoadRef.current === activeThreadId) {
      skipNextHistoryLoadRef.current = null;
      return () => {
        canceled = true;
      };
    }

    getThread(activeThreadId)
      .then(({ runs }) => {
        if (!canceled) setMessages(runsToUiMessages(runs));
      })
      .catch(() => {
        if (!canceled) setMessages([]);
      });

    return () => {
      canceled = true;
    };
  }, [activeThreadId, setMessages]);

  function newChat() {
    stop();
    setRightPanelOpen(false);
    navigateChatRoute({ draft: '', threadId: null });
    setMessages([]);
  }

  function selectThread(id: string) {
    stop();
    setRightPanelOpen(false);
    navigateChatRoute({ draft: '', threadId: id });
  }

  function openSettings() {
    stop();
    setRightPanelOpen(false);
    navigateSettings();
  }

  async function removeThread(id: string) {
    if (!window.confirm('删除这个会话？相关运行记录也会一起删除。')) return;
    stop();
    await deleteThread(id);
    setThreads((current) => current.filter((t) => t.id !== id));
    if (activeThreadId === id) {
      navigateChatRoute({ draft: '', threadId: null });
      setMessages([]);
    }
  }

  function changeDraft(text: string) {
    navigateChatRoute({ draft: text, threadId: activeThreadId }, 'replace');
  }

  function send(text: string) {
    const finalText = attachments.length
      ? `${text}\n\n${attachments.map(attachmentToken).join('\n')}`
      : text;
    navigateChatRoute({ draft: '', threadId: activeThreadId }, 'replace');
    setAttachments([]);
    void sendMessage({ text: finalText });
  }

  function addAttachment(next: ComposerAttachment) {
    setAttachments((current) => {
      if (current.some((a) => a.path === next.path)) return current;
      return [...current, next];
    });
  }

  async function uploadLocalAttachment(file: File, path: string) {
    const contentBase64 = await fileToBase64(file);
    const uploaded = await uploadLocalFile(path, contentBase64);
    addAttachment({ kind: 'local', path: uploaded.path, name: file.name, size: uploaded.size });
  }

  function openRemoteFile(path: string) {
    setPreviewPath(path);
    setRightPanelOpen(true);
  }

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const title = activeThread?.title ?? (activeThreadId ? '会话' : '新会话');

  return (
    <div className="flex h-full">
      <Sidebar
        threads={threads}
        activeId={activeThreadId}
        activeView={activeView}
        width={sidebarWidth}
        theme={theme}
        onToggleTheme={toggleTheme}
        onNew={newChat}
        onSettings={openSettings}
        onSelect={selectThread}
        onDelete={(id) => void removeThread(id)}
      />
      <div
        role="separator"
        aria-label="调整会话列表宽度"
        className="h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/60"
        onPointerDown={(event) =>
          beginHorizontalResize(event, {
            width: sidebarWidth,
            min: 200,
            max: 420,
            direction: 1,
            onChange: setSidebarWidth,
          })
        }
      />
      {activeView === 'settings' ? (
        <SettingsView onWorkspaceChanged={refreshWorkspaceRoot} />
      ) : (
        <ChatView
          title={title}
          messages={messages}
          busy={busy}
          draft={draft}
          wide={wide}
          workspaceRoot={workspaceRoot}
          attachments={attachments}
          onDraftChange={changeDraft}
          onSend={send}
          onToggleWide={() => setWide((v) => !v)}
          onRemoveAttachment={(path) => setAttachments((current) => current.filter((a) => a.path !== path))}
          onOpenRemoteFiles={() => {
            setPreviewPath(null);
            setRightPanelOpen(true);
          }}
          onUploadLocal={uploadLocalAttachment}
          onOpenRemoteFile={openRemoteFile}
        />
      )}
      {activeView === 'chat' && rightPanelOpen && (
        <div
          role="separator"
          aria-label="调整文件区域宽度"
          className="h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/60"
          onPointerDown={(event) =>
            beginHorizontalResize(event, {
              width: filesPanelWidth,
              min: 460,
              max: Math.max(520, window.innerWidth - sidebarWidth - 360),
              direction: -1,
              onChange: setFilesPanelWidth,
            })
          }
        />
      )}
      <RemoteFilesPanel
        open={activeView === 'chat' && rightPanelOpen}
        width={filesPanelWidth}
        previewPath={previewPath}
        onClose={() => setRightPanelOpen(false)}
        onAttach={addAttachment}
      />
    </div>
  );
}
