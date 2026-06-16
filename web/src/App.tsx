import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import {
  answerRun,
  cancelRun,
  deleteThread,
  getPageState,
  getRemoteFileInfo,
  getThread,
  listThreads,
  subscribeRun,
  updatePageState,
  uploadLocalFile,
  type AskUserAnswer,
  type AskUserSpec,
  type AgentEvent,
  type PageState,
  type RunWithEvents,
  type Thread,
} from './api';
import { createAiSdkChatTransport, type ChatThreadHandle } from './transport/aiSdkChat';
import { foldUiEventsToParts, runsToUiMessages } from './history';
import { toUiEvent } from './transport/legacy';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { RightSidebar, type RightTabId } from './components/RightSidebar';
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

const SIDEBAR_COLLAPSED_WIDTH = 56;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_SNAP_WIDTH = 104;

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

function beginSidebarResize(
  event: ReactPointerEvent,
  options: {
    width: number;
    collapsed: boolean;
    previewElement: HTMLElement | null;
    onWidthChange: (width: number) => void;
    onCollapsedChange: (collapsed: boolean) => void;
  },
) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = options.collapsed ? SIDEBAR_COLLAPSED_WIDTH : options.width;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  let latestWidth = startWidth;
  let latestCollapsed = options.collapsed;
  let pendingWidth = startWidth;
  let resizeFrame = 0;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const applyWidth = (rawWidth: number) => {
    latestWidth = rawWidth;
    const shouldCollapse = rawWidth < SIDEBAR_SNAP_WIDTH;
    const previewWidth = shouldCollapse ? SIDEBAR_COLLAPSED_WIDTH : clamp(rawWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    if (shouldCollapse !== latestCollapsed) {
      latestCollapsed = shouldCollapse;
      if (!shouldCollapse) {
        flushSync(() => {
          options.onWidthChange(previewWidth);
          options.onCollapsedChange(false);
        });
      } else {
        flushSync(() => {
          options.onCollapsedChange(true);
        });
      }
    }
    if (options.previewElement) {
      options.previewElement.style.width = `${previewWidth}px`;
    }
  };

  const onMove = (moveEvent: PointerEvent) => {
    pendingWidth = startWidth + moveEvent.clientX - startX;
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      applyWidth(pendingWidth);
    });
  };
  const onUp = () => {
    if (resizeFrame) {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
      applyWidth(pendingWidth);
    }
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    if (latestWidth < SIDEBAR_SNAP_WIDTH) {
      options.onCollapsedChange(true);
    } else {
      options.onCollapsedChange(false);
      options.onWidthChange(clamp(latestWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}

function attachmentToken(att: ComposerAttachment): string {
  if (att.kind === 'shell') {
    return att.text ?? `用户标记了 shell 交互：${att.name}`;
  }
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

function isRightTabId(value: unknown): value is RightTabId {
  return value === 'files'
    || (typeof value === 'string' && (value.startsWith('file:') || value.startsWith('shell:') || value.startsWith('subagent:')));
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rightTabsValue(value: unknown): RightTabId[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRightTabId).slice(0, 30);
}

interface ThreadPanelState {
  rightPanelOpen: boolean;
  rightPanelTabs: RightTabId[];
  rightPanelMode: RightTabId | null;
  statusCardOpen: boolean;
}

const EMPTY_THREAD_PANEL_STATE: ThreadPanelState = {
  rightPanelOpen: false,
  rightPanelTabs: [],
  rightPanelMode: null,
  statusCardOpen: false,
};

function threadPanelStateValue(value: unknown): ThreadPanelState {
  const object = objectValue(value);
  const tabs = rightTabsValue(object.rightPanelTabs);
  const mode = isRightTabId(object.rightPanelMode) && tabs.includes(object.rightPanelMode) ? object.rightPanelMode : tabs[0] ?? null;
  return {
    rightPanelOpen: typeof object.rightPanelOpen === 'boolean' ? object.rightPanelOpen && tabs.length > 0 : false,
    rightPanelTabs: tabs,
    rightPanelMode: mode,
    statusCardOpen: typeof object.statusCardOpen === 'boolean' ? object.statusCardOpen : false,
  };
}

function threadPanelStatesValue(value: unknown): Record<string, ThreadPanelState> {
  const object = objectValue(value);
  const states: Record<string, ThreadPanelState> = {};
  for (const [threadId, rawState] of Object.entries(object)) {
    if (threadId) states[threadId] = threadPanelStateValue(rawState);
  }
  return states;
}

function threadDraftsValue(value: unknown): Record<string, string> {
  const object = objectValue(value);
  const drafts: Record<string, string> = {};
  for (const [threadId, draftText] of Object.entries(object)) {
    if (threadId && typeof draftText === 'string') drafts[threadId] = draftText;
  }
  return drafts;
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
  const [composerDraft, setComposerDraft] = useState(route.draft);
  const [wide, setWide] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTabs, setRightPanelTabs] = useState<RightTabId[]>([]);
  const [rightPanelMode, setRightPanelMode] = useState<RightTabId | null>(null);
  const [threadPanelStates, setThreadPanelStates] = useState<Record<string, ThreadPanelState>>({});
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [statusCardOpen, setStatusCardOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filesPanelWidth, setFilesPanelWidth] = useState(720);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [waitingRun, setWaitingRun] = useState<{ id: string; spec: AskUserSpec } | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [askUserDrafts, setAskUserDrafts] = useState<Record<string, AskUserDraft>>({});
  const [pageStateLoaded, setPageStateLoaded] = useState(false);
  const { theme, toggle: toggleTheme } = useThemeCtx();
  const activeThreadId = route.threadId;
  const sidebarFrameRef = useRef<HTMLDivElement>(null);
  const conversationContentRef = useRef<HTMLDivElement>(null);
  const previousPanelThreadIdRef = useRef(activeThreadId);
  const threadPanelStatesRef = useRef<Record<string, ThreadPanelState>>({});
  const threadDraftsRef = useRef<Record<string, string>>({});
  const draftRef = useRef(route.draft);
  const draftSyncTimerRef = useRef<number | null>(null);
  const draftRouteTimerRef = useRef<number | null>(null);

  // 活跃会话 ID 放在 ref 中，稳定的 transport 可以读取和更新它，
  // 不需要在每次选择会话时重新创建 transport。
  const threadIdRef = useRef<string | null>(null);
  const skipNextHistoryLoadRef = useRef<string | null>(null);
  threadIdRef.current = activeThreadId;

  const currentThreadPanelState = useCallback((): ThreadPanelState => ({
    rightPanelOpen: rightPanelOpen && rightPanelTabs.length > 0,
    rightPanelTabs,
    rightPanelMode: rightPanelMode && rightPanelTabs.includes(rightPanelMode) ? rightPanelMode : rightPanelTabs[0] ?? null,
    statusCardOpen,
  }), [rightPanelMode, rightPanelOpen, rightPanelTabs, statusCardOpen]);

  const rememberThreadPanelState = useCallback((threadId: string, state: ThreadPanelState) => {
    setThreadPanelStates((current) => {
      const next = { ...current, [threadId]: state };
      threadPanelStatesRef.current = next;
      return next;
    });
  }, []);

  const applyThreadPanelState = useCallback((state: ThreadPanelState) => {
    setRightPanelTabs(state.rightPanelTabs);
    setRightPanelMode(state.rightPanelMode);
    setRightPanelOpen(state.rightPanelOpen);
    setStatusCardOpen(state.statusCardOpen);
  }, []);

  const rememberThreadDraft = useCallback((threadId: string, draftText: string) => {
    setThreadDrafts((current) => {
      const next = { ...current };
      if (draftText) next[threadId] = draftText;
      else delete next[threadId];
      threadDraftsRef.current = next;
      return next;
    });
  }, []);

  const rememberThreadDraftRef = useCallback((threadId: string, draftText: string) => {
    const next = { ...threadDraftsRef.current };
    if (draftText) next[threadId] = draftText;
    else delete next[threadId];
    threadDraftsRef.current = next;
  }, []);

  const scheduleThreadDraftSync = useCallback(() => {
    if (draftSyncTimerRef.current) window.clearTimeout(draftSyncTimerRef.current);
    draftSyncTimerRef.current = window.setTimeout(() => {
      draftSyncTimerRef.current = null;
      setThreadDrafts(threadDraftsRef.current);
    }, 250);
  }, []);

  const replaceDraftRouteLater = useCallback((threadId: string | null, draftText: string) => {
    if (draftRouteTimerRef.current) window.clearTimeout(draftRouteTimerRef.current);
    draftRouteTimerRef.current = window.setTimeout(() => {
      draftRouteTimerRef.current = null;
      const path = buildChatPath({ draft: draftText, threadId });
      if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
    }, 150);
  }, []);

  const flushPendingDraftSync = useCallback(() => {
    if (draftRouteTimerRef.current) {
      window.clearTimeout(draftRouteTimerRef.current);
      draftRouteTimerRef.current = null;
    }
    if (draftSyncTimerRef.current) {
      window.clearTimeout(draftSyncTimerRef.current);
      draftSyncTimerRef.current = null;
      setThreadDrafts(threadDraftsRef.current);
    }
  }, []);

  const refreshThreads = useCallback(() => {
    listThreads().then(setThreads).catch(() => {});
  }, []);
  useEffect(refreshThreads, [refreshThreads]);

  const refreshWorkspaceRoot = useCallback(() => {
    getRemoteFileInfo().then((info) => setWorkspaceRoot(info.workspaceRoot)).catch(() => setWorkspaceRoot(null));
  }, []);
  useEffect(refreshWorkspaceRoot, [refreshWorkspaceRoot]);

  useEffect(() => {
    let canceled = false;
    getPageState()
      .then((state) => {
        if (canceled) return;
        const layout = objectValue(state.layout);
        const chat = objectValue(state.chat);
        const savedThreadId = typeof chat.threadId === 'string' ? chat.threadId : null;
        const savedThreadStates = threadPanelStatesValue(chat.threadStates);
        const savedDrafts = threadDraftsValue(chat.threadDrafts);
        if (savedThreadId && !savedThreadStates[savedThreadId]) {
          savedThreadStates[savedThreadId] = threadPanelStateValue(chat);
        }
        if (savedThreadId && typeof chat.draft === 'string' && chat.draft) {
          savedDrafts[savedThreadId] = chat.draft;
        }
        if (activeThreadId && draftRef.current) {
          savedDrafts[activeThreadId] = draftRef.current;
        }

        setSidebarWidth((current) => numberInRange(layout.sidebarWidth, current, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
        setSidebarCollapsed(typeof layout.sidebarCollapsed === 'boolean' ? layout.sidebarCollapsed : false);
        setFilesPanelWidth((current) => numberInRange(layout.rightPanelWidth, current, 360, 1200));
        setWide(typeof chat.wide === 'boolean' ? chat.wide : false);
        setThreadPanelStates(savedThreadStates);
        threadPanelStatesRef.current = savedThreadStates;
        setThreadDrafts(savedDrafts);
        threadDraftsRef.current = savedDrafts;
        applyThreadPanelState(activeThreadId ? savedThreadStates[activeThreadId] ?? EMPTY_THREAD_PANEL_STATE : EMPTY_THREAD_PANEL_STATE);
        if (activeThreadId && !draftRef.current) {
          const savedDraft = savedDrafts[activeThreadId] ?? '';
          draftRef.current = savedDraft;
          setComposerDraft(savedDraft);
        }
      })
      .catch((err) => console.error('load page state failed', err))
      .finally(() => {
        if (!canceled) setPageStateLoaded(true);
      });
    return () => {
      canceled = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!pageStateLoaded) return;
    const previousThreadId = previousPanelThreadIdRef.current;
    if (previousThreadId === activeThreadId) return;
    if (previousThreadId) rememberThreadPanelState(previousThreadId, currentThreadPanelState());
    previousPanelThreadIdRef.current = activeThreadId;
    applyThreadPanelState(activeThreadId ? threadPanelStatesRef.current[activeThreadId] ?? EMPTY_THREAD_PANEL_STATE : EMPTY_THREAD_PANEL_STATE);
  }, [activeThreadId, applyThreadPanelState, currentThreadPanelState, pageStateLoaded, rememberThreadPanelState]);

  useEffect(() => {
    if (!pageStateLoaded || !activeThreadId) return;
    rememberThreadPanelState(activeThreadId, currentThreadPanelState());
  }, [activeThreadId, currentThreadPanelState, pageStateLoaded, rememberThreadPanelState]);

  useEffect(() => {
    if (!pageStateLoaded) return undefined;
    const activePanelState = currentThreadPanelState();
    const savedThreadStates = activeThreadId ? { ...threadPanelStates, [activeThreadId]: activePanelState } : threadPanelStates;
    const savedThreadDrafts = { ...threadDrafts };
    if (activeThreadId) {
      if (draftRef.current) savedThreadDrafts[activeThreadId] = draftRef.current;
      else delete savedThreadDrafts[activeThreadId];
    }
    const state: PageState = {
      version: 1,
      view: activeView,
      layout: {
        sidebarWidth,
        sidebarCollapsed,
        rightPanelWidth: filesPanelWidth,
      },
      chat: {
        threadId: activeThreadId,
        wide,
        draft: draftRef.current,
        rightPanelOpen: activePanelState.rightPanelOpen,
        rightPanelTabs: activePanelState.rightPanelTabs,
        rightPanelMode: activePanelState.rightPanelMode,
        statusCardOpen: activePanelState.statusCardOpen,
        threadStates: savedThreadStates,
        threadDrafts: savedThreadDrafts,
      },
    };
    const timer = window.setTimeout(() => {
      void updatePageState(state).catch((err) => console.error('save page state failed', err));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [activeThreadId, activeView, currentThreadPanelState, filesPanelWidth, pageStateLoaded, sidebarCollapsed, sidebarWidth, threadDrafts, threadPanelStates, wide]);

  const navigateChatRoute = useCallback((next: ChatRoute, mode: 'push' | 'replace' = 'push') => {
    flushPendingDraftSync();
    const path = buildChatPath(next);
    if (currentBrowserPath() !== path) {
      if (mode === 'replace') window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    setRoute(next);
    draftRef.current = next.draft;
    setComposerDraft(next.draft);
    setActiveView('chat');
  }, [flushPendingDraftSync]);

  useEffect(() => () => {
    if (draftRouteTimerRef.current) window.clearTimeout(draftRouteTimerRef.current);
    if (draftSyncTimerRef.current) window.clearTimeout(draftSyncTimerRef.current);
  }, []);

  const navigateSettings = useCallback(() => {
    flushPendingDraftSync();
    if (currentBrowserPath() !== '/settings') window.history.pushState(null, '', '/settings');
    setActiveView('settings');
  }, [flushPendingDraftSync]);

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
      flushPendingDraftSync();
      stop();
      setActiveView(window.location.pathname === '/settings' ? 'settings' : 'chat');
      const next = readChatRoute();
      setRoute(next);
      draftRef.current = next.draft;
      setComposerDraft(next.draft);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [flushPendingDraftSync, stop]);

  useEffect(() => {
    let canceled = false;

    if (!activeThreadId) {
      draftRef.current = route.draft;
      setComposerDraft(route.draft);
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
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateChatRoute({ draft: '', threadId: null });
    setMessages([]);
  }

  function selectThread(id: string) {
    stop();
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateChatRoute({ draft: threadDraftsRef.current[id] ?? '', threadId: id });
  }

  function openSettings() {
    stop();
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateSettings();
  }

  async function removeThread(id: string) {
    if (!window.confirm('删除这个会话？相关运行记录也会一起删除。')) return;
    stop();
    await deleteThread(id);
    setThreads((current) => current.filter((t) => t.id !== id));
    setThreadPanelStates((current) => {
      const next = { ...current };
      delete next[id];
      threadPanelStatesRef.current = next;
      return next;
    });
    setThreadDrafts((current) => {
      const next = { ...current };
      delete next[id];
      threadDraftsRef.current = next;
      return next;
    });
    if (activeThreadId === id) {
      navigateChatRoute({ draft: '', threadId: null });
      setMessages([]);
    }
  }

  function changeDraft(text: string) {
    draftRef.current = text;
    if (activeThreadId) {
      rememberThreadDraftRef(activeThreadId, text);
      scheduleThreadDraftSync();
    }
    replaceDraftRouteLater(activeThreadId, text);
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
        let renderFrame = 0;
        const flushEvents = () => {
          renderFrame = 0;
          setMessages((current) => replaceAssistantMessage(current, runId, events));
        };
        unsubscribe = subscribeRun(
          runId,
          (event) => {
            events.push(event);
            if (renderFrame) return;
            renderFrame = window.requestAnimationFrame(flushEvents);
          },
          () => {
            if (renderFrame) {
              window.cancelAnimationFrame(renderFrame);
              flushEvents();
            }
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
    if (activeThreadId) rememberThreadDraft(activeThreadId, '');
    draftRef.current = '';
    setComposerDraft('');
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

  function openRightTab(tab: RightTabId) {
    setRightPanelTabs((current) => current.includes(tab) ? current : [...current, tab]);
    setRightPanelMode(tab);
    setRightPanelOpen(true);
    setStatusCardOpen(false);
  }

  function closeRightTab(tab: RightTabId) {
    setRightPanelTabs((current) => {
      const next = current.filter((item) => item !== tab);
      if (rightPanelMode === tab) {
        const currentIndex = current.indexOf(tab);
        const replacement = next[currentIndex] ?? next[currentIndex - 1] ?? next[0] ?? null;
        setRightPanelMode(replacement);
        if (!replacement) setRightPanelOpen(false);
      }
      return next;
    });
  }

  function toggleRightPanel() {
    setRightPanelOpen((open) => !open);
    setStatusCardOpen(false);
  }

  function openRemoteFile(path: string) {
    openRightTab(`file:${path}`);
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
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <div
        ref={sidebarFrameRef}
        className="h-full shrink-0 overflow-hidden"
        style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
      >
        <Sidebar
          threads={threads}
          activeId={activeThreadId}
          activeView={activeView}
          width="100%"
          collapsed={sidebarCollapsed}
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onNew={newChat}
          onSettings={openSettings}
          onSelect={selectThread}
          onDelete={(id) => void removeThread(id)}
        />
      </div>
      <div
        role="separator"
        aria-label="拖拽调整或收起会话列表"
        className="h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/60"
        onPointerDown={(event) =>
          beginSidebarResize(event, {
            width: sidebarWidth,
            collapsed: sidebarCollapsed,
            previewElement: sidebarFrameRef.current,
            onWidthChange: setSidebarWidth,
            onCollapsedChange: setSidebarCollapsed,
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
          draft={composerDraft}
          wide={wide}
          workspaceRoot={workspaceRoot}
          threadId={activeThreadId}
          contentRef={conversationContentRef}
          askUserDrafts={askUserDrafts}
          attachments={attachments}
          onDraftChange={changeDraft}
          onSend={send}
          onCancel={cancelActiveRun}
          onToggleWide={() => setWide((v) => !v)}
          onRemoveAttachment={(path) => setAttachments((current) => current.filter((a) => a.path !== path))}
          rightPanelOpen={rightPanelOpen}
          statusCardOpen={statusCardOpen}
          onToggleStatusCard={() => setStatusCardOpen((open) => !open)}
          onToggleRightPanel={toggleRightPanel}
          onOpenShellPreview={(sessionId) => openRightTab(`shell:${sessionId}`)}
          onOpenSubagentPreview={(subagentId) => openRightTab(`subagent:${subagentId}`)}
          onOpenRemoteFiles={() => openRightTab('files')}
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
          aria-label="调整右侧工作区宽度"
          className="h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/60"
          onPointerDown={(event) =>
            beginHorizontalResize(event, {
              width: filesPanelWidth,
              min: 460,
              max: Math.max(520, window.innerWidth - (sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth) - 360),
              direction: -1,
              onChange: setFilesPanelWidth,
            })
          }
        />
      )}
      <RightSidebar
        open={activeView === 'chat' && rightPanelOpen}
        width={filesPanelWidth}
        tabs={rightPanelTabs}
        activeTab={rightPanelMode}
        threadId={activeThreadId}
        workspaceRoot={workspaceRoot}
        onTabChange={setRightPanelMode}
        onOpenFileBrowser={() => openRightTab('files')}
        onOpenFileTab={openRemoteFile}
        onOpenShellTab={(sessionId) => openRightTab(`shell:${sessionId}`)}
        onOpenSubagentTab={(subagentId) => openRightTab(`subagent:${subagentId}`)}
        onCloseTab={closeRightTab}
        onClose={() => setRightPanelOpen(false)}
        onAttach={addAttachment}
      />
    </div>
  );
}
