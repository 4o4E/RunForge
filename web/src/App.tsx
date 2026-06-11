import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import {
  answerRun,
  cancelRun,
  deleteThread,
  getRemoteFileInfo,
  getThread,
  listThreads,
  subscribeRun,
  uploadLocalFile,
  type AskUserAnswer,
  type AskUserSpec,
  type AgentEvent,
  type RunWithEvents,
  type Thread,
} from './api';
import { createAiSdkChatTransport, type ChatThreadHandle } from './transport/aiSdkChat';
import { foldUiEventsToParts, runsToUiMessages } from './history';
import { toUiEvent } from './transport/legacy';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { RemoteFilesPanel } from './components/RemoteFilesPanel';
import { SettingsView } from './components/SettingsView';
import type { ComposerAttachment } from './components/Composer';
import type { AskUserDraft } from './components/AskUserCard';
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

function defaultAskSpec(question: string): AskUserSpec {
  return { question, mode: 'text', options: [], allowCustom: false, required: false };
}

function waitingRunFrom(runs: RunWithEvents[]): { id: string; spec: AskUserSpec } | null {
  const run = [...runs].reverse().find((r) => r.status === 'waiting_for_user');
  if (!run) return null;
  const event = [...run.events].reverse().find((e) => e.type === 'user_question');
  const question = event?.question ?? '请补充信息后继续。';
  return { id: run.id, spec: event?.spec ?? defaultAskSpec(question) };
}

function assistantMessageFromEvents(runId: string, events: AgentEvent[]): UIMessage {
  const parts = foldUiEventsToParts(events.map(toUiEvent).filter((e): e is NonNullable<ReturnType<typeof toUiEvent>> => e !== null));
  parts.unshift({ type: 'data-run-id', id: runId, data: { runId } } as unknown as UIMessage['parts'][number]);
  return { id: `${runId}:a`, role: 'assistant', parts };
}

function replaceAssistantMessage(messages: UIMessage[], runId: string, events: AgentEvent[]): UIMessage[] {
  const assistant = assistantMessageFromEvents(runId, events);
  const index = messages.findIndex((m) => m.id === assistant.id);
  if (index >= 0) return messages.map((m, i) => (i === index ? assistant : m));
  return [...messages, assistant];
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
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [waitingRun, setWaitingRun] = useState<{ id: string; spec: AskUserSpec } | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [askUserDrafts, setAskUserDrafts] = useState<Record<string, AskUserDraft>>({});
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
      setActiveRunId,
    }),
    [navigateChatRoute, refreshThreads],
  );

  const transport = useMemo(() => createAiSdkChatTransport(handle), [handle]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({ transport });
  const busy = status === 'submitted' || status === 'streaming' || !!resumingRunId;

  useEffect(() => {
    if (!busy) setActiveRunId(null);
  }, [busy]);

  useEffect(() => {
    if (busy || !activeThreadId) return;
    let canceled = false;
    getThread(activeThreadId)
      .then(({ runs }) => {
        if (canceled) return;
        setWaitingRun(waitingRunFrom(runs));
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [busy, activeThreadId]);

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
        if (!canceled) {
          setMessages(runsToUiMessages(runs));
          setWaitingRun(waitingRunFrom(runs));
        }
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

  const refreshActiveThread = useCallback(() => {
    if (!activeThreadId) return;
    void getThread(activeThreadId).then(({ runs }) => {
      setMessages(runsToUiMessages(runs));
      setWaitingRun(waitingRunFrom(runs));
    });
  }, [activeThreadId, setMessages]);

  const resumeWithAnswer = useCallback((runId: string, answer: AskUserAnswer) => {
    setWaitingRun(null);
    setResumingRunId(runId);
    setActiveRunId(runId);
    void answerRun(runId, answer)
      .then(() => {
        let unsubscribe = () => {};
        const events: AgentEvent[] = [];
        unsubscribe = subscribeRun(
          runId,
          (event) => {
            events.push(event);
            setMessages((current) => replaceAssistantMessage(current, runId, events));
          },
          () => {
            unsubscribe();
            refreshActiveThread();
            setResumingRunId(null);
            setActiveRunId(null);
            setAskUserDrafts((current) => {
              const next = { ...current };
              delete next[runId];
              return next;
            });
            refreshThreads();
          },
        );
      })
      .catch((err) => {
        console.error('answer run failed', err);
        setResumingRunId(null);
        setActiveRunId(null);
      });
  }, [refreshActiveThread, refreshThreads]);

  const cancelAskUser = useCallback((runId: string) => {
    setWaitingRun((current) => (current?.id === runId ? null : current));
    setAskUserDrafts((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    void cancelRun(runId)
      .then(() => {
        refreshActiveThread();
        refreshThreads();
      })
      .catch((err) => {
        console.error('cancel ask_user run failed', err);
        refreshActiveThread();
      });
  }, [refreshActiveThread, refreshThreads]);

  function send(text: string) {
    if (waitingRun) return;
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

  function cancelActiveRun() {
    const runId = activeRunId;
    if (!runId) {
      stop();
      return;
    }
    // 先发后端取消请求，再立即停本地流；后端失败会暴露在控制台，界面不被挂住。
    void cancelRun(runId).catch((err) => console.error('cancel run failed', err));
    stop();
    setActiveRunId(null);
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
          waitingQuestion={waitingRun?.spec.question ?? null}
          draft={draft}
          wide={wide}
          workspaceRoot={workspaceRoot}
          askUserDrafts={askUserDrafts}
          attachments={attachments}
          onDraftChange={changeDraft}
          onSend={send}
          onCancel={cancelActiveRun}
          onToggleWide={() => setWide((v) => !v)}
          onRemoveAttachment={(path) => setAttachments((current) => current.filter((a) => a.path !== path))}
          filesOpen={rightPanelOpen}
          onToggleRemoteFiles={() => {
            setPreviewPath(null);
            setRightPanelOpen((open) => !open);
          }}
          onOpenRemoteFiles={() => {
            setPreviewPath(null);
            setRightPanelOpen(true);
          }}
          onUploadLocal={uploadLocalAttachment}
          onOpenRemoteFile={openRemoteFile}
          onAskUserDraftChange={(runId, next) => setAskUserDrafts((current) => ({ ...current, [runId]: next }))}
          onAskUserSubmit={resumeWithAnswer}
          onAskUserCancel={cancelAskUser}
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
