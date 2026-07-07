import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import {
  answerRun,
  branchRun,
  cancelRun,
  deleteThread,
  forkThreadFromRun,
  getLlmSettings,
  getPageState,
  getRemoteFileInfo,
  getThread,
  listThreads,
  subscribeRun,
  updatePageState,
  updateThread,
  uploadLocalFile,
  type AskUserAnswer,
  type AskUserSpec,
  type AgentEvent,
  type LlmModelOption,
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
import { SearchView } from './components/SearchView';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';
import type { ComposerAttachment } from './components/Composer';
import type { AskUserDraft } from './components/AskUserCard';
import { buildChatPath, currentBrowserPath, readChatRoute, type ChatRoute } from './router';
import { llmOptionsFromSettings } from './components/ModelSearchSelect';
import { useNotifications } from './components/GlobalNotifications';
import { browserPushSupported, currentBrowserPushPermission, disableBrowserPush, enableBrowserPush, readBrowserPushState, type BrowserPushState } from './notifications';
import { cn } from './lib/utils';

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
const RIGHT_PANEL_SNAP_WIDTH = 360;
const RIGHT_PANEL_TRANSITION_MS = 200;
const MODEL_SELECTION_STORAGE_KEY = 'runforge:selected-model-ref';
const LEGACY_MODEL_SELECTION_STORAGE_KEY = 'my-agent:selected-model-ref';
const TITLE_REFRESH_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
const MOBILE_MEDIA_QUERY = '(max-width: 767px)';

type ActiveView = 'chat' | 'search';

function useIsMobileViewport(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_MEDIA_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return mobile;
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const sync = () => setWidth(window.innerWidth);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);
  return width;
}

function activeViewFromPath(pathname = window.location.pathname): ActiveView {
  if (pathname === '/search') return 'search';
  return 'chat';
}

function isSettingsPath(pathname = window.location.pathname): boolean {
  return pathname === '/settings';
}

function readStoredModelRef(): string {
  try {
    const current = window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY);
    if (current != null) return current;
    return window.localStorage.getItem(LEGACY_MODEL_SELECTION_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeStoredModelRef(modelRef: string) {
  try {
    window.localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, modelRef);
    window.localStorage.removeItem(LEGACY_MODEL_SELECTION_STORAGE_KEY);
  } catch {
    // 本地存储不可用时只影响“记住模型”，不影响本次发送。
  }
}

function beginRightPanelResize(
  event: ReactPointerEvent,
  options: {
    width: number;
    min: number;
    max: number;
    onWidthChange: (width: number) => void;
    onOpenChange: (open: boolean) => void;
  },
) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = options.width;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  let latestRawWidth = startWidth;
  let pendingClientX = startX;
  let resizeFrame = 0;
  const previewLine = document.createElement('div');
  previewLine.setAttribute('aria-hidden', 'true');
  previewLine.className = 'right-panel-resize-preview';
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  document.body.appendChild(previewLine);

  const movePreviewLine = (clientX: number) => {
    latestRawWidth = startWidth + startX - clientX;
    const previewWidth = latestRawWidth < RIGHT_PANEL_SNAP_WIDTH ? 0 : clamp(latestRawWidth, options.min, options.max);
    previewLine.style.left = `${window.innerWidth - previewWidth}px`;
  };
  movePreviewLine(startX);

  const onMove = (moveEvent: PointerEvent) => {
    pendingClientX = moveEvent.clientX;
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      movePreviewLine(pendingClientX);
    });
  };
  const finishResize = (commit: boolean) => {
    if (resizeFrame) {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
      movePreviewLine(pendingClientX);
    }
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    previewLine.remove();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    if (!commit) return;
    if (latestRawWidth < RIGHT_PANEL_SNAP_WIDTH) {
      options.onOpenChange(false);
    } else {
      options.onWidthChange(clamp(latestRawWidth, options.min, options.max));
      options.onOpenChange(true);
    }
  };
  const onUp = () => {
    finishResize(true);
  };
  const onCancel = () => {
    finishResize(false);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
  window.addEventListener('pointercancel', onCancel, { once: true });
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
  let snapTimer = 0;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  if (options.previewElement) {
    options.previewElement.dataset.sidebarResizing = 'true';
  }

  const markSidebarSnap = () => {
    if (!options.previewElement) return;
    options.previewElement.dataset.sidebarSnap = 'true';
    if (snapTimer) window.clearTimeout(snapTimer);
    snapTimer = window.setTimeout(() => {
      delete options.previewElement?.dataset.sidebarSnap;
      snapTimer = 0;
    }, 220);
  };

  const applyWidth = (rawWidth: number) => {
    latestWidth = rawWidth;
    const shouldCollapse = rawWidth < SIDEBAR_SNAP_WIDTH;
    const previewWidth = shouldCollapse ? SIDEBAR_COLLAPSED_WIDTH : clamp(rawWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    if (shouldCollapse !== latestCollapsed) {
      markSidebarSnap();
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
    if (options.previewElement) {
      delete options.previewElement.dataset.sidebarResizing;
    }
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

function liveRunFrom(runs: RunWithEvents[]): RunWithEvents | null {
  return [...runs].reverse().find((r) => r.status === 'pending' || r.status === 'running' || r.status === 'canceling') ?? null;
}

function activeBranchRuns(runs: RunWithEvents[], activeRunId: string | null): RunWithEvents[] {
  if (!activeRunId) return runs;
  const byId = new Map(runs.map((run) => [run.id, run]));
  const path: RunWithEvents[] = [];
  const seen = new Set<string>();
  let cursor: string | null = activeRunId;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const run = byId.get(cursor);
    if (!run) return runs;
    path.push(run);
    cursor = run.parent_run_id;
  }
  return path.reverse();
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

function assistantRunId(message: UIMessage): string | null {
  if (message.role !== 'assistant') return null;
  const part = message.parts.find((p) => p.type === 'data-run-id') as { data?: { runId?: string } } | undefined;
  return part?.data?.runId ?? null;
}

function replaceAssistantMessage(messages: UIMessage[], runId: string, events: AgentEvent[]): UIMessage[] {
  const assistant = assistantMessageFromEvents(runId, events);
  // AI SDK 直播消息的 id 由 SDK 生成；恢复 ask_user 时必须用 data-run-id 对齐同一个 run。
  const index = messages.findIndex((m) => m.id === assistant.id || assistantRunId(m) === runId);
  if (index >= 0) return messages.map((m, i) => (i === index ? assistant : m));
  return [...messages, assistant];
}

export function App() {
  const { notify } = useNotifications();
  const isMobile = useIsMobileViewport();
  const viewportWidth = useViewportWidth();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [route, setRoute] = useState<ChatRoute>(() => readChatRoute());
  const [activeView, setActiveView] = useState<ActiveView>(() => activeViewFromPath());
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsPath());
  const [composerDraft, setComposerDraft] = useState(route.draft);
  const [wide, setWide] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelClosing, setRightPanelClosing] = useState(false);
  const [rightPanelTabs, setRightPanelTabs] = useState<RightTabId[]>([]);
  const [rightPanelMode, setRightPanelMode] = useState<RightTabId | null>(null);
  const [threadPanelStates, setThreadPanelStates] = useState<Record<string, ThreadPanelState>>({});
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [statusCardOpen, setStatusCardOpen] = useState(false);
  const [mobileStatusCardOpen, setMobileStatusCardOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileRightPanelOpen, setMobileRightPanelOpen] = useState(false);
  const [filesPanelWidth, setFilesPanelWidth] = useState(720);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [modelOptions, setModelOptions] = useState<LlmModelOption[]>([]);
  const [selectedModelRef, setSelectedModelRef] = useState(() => readStoredModelRef());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [reattachedRunId, setReattachedRunId] = useState<string | null>(null);
  const [waitingRun, setWaitingRun] = useState<{ id: string; spec: AskUserSpec } | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [askUserDrafts, setAskUserDrafts] = useState<Record<string, AskUserDraft>>({});
  const [pageStateLoaded, setPageStateLoaded] = useState(false);
  const [pushState, setPushState] = useState<BrowserPushState>(() => ({
    supported: browserPushSupported(),
    permission: currentBrowserPushPermission(),
    subscribed: false,
    busy: false,
    error: null,
  }));
  const activeThreadId = route.threadId;
  const sidebarFrameRef = useRef<HTMLDivElement>(null);
  const conversationContentRef = useRef<HTMLDivElement>(null);
  const previousPanelThreadIdRef = useRef(activeThreadId);
  const threadPanelStatesRef = useRef<Record<string, ThreadPanelState>>({});
  const threadDraftsRef = useRef<Record<string, string>>({});
  const draftRef = useRef(route.draft);
  const modelOptionsRef = useRef<LlmModelOption[]>([]);
  const selectedModelRefRef = useRef(selectedModelRef);
  const reattachedEventsRef = useRef<AgentEvent[]>([]);
  const draftSyncTimerRef = useRef<number | null>(null);
  const draftRouteTimerRef = useRef<number | null>(null);
  const titleRefreshTimersRef = useRef<number[]>([]);
  const previousRightPanelVisibleRef = useRef(false);
  const rightPanelCloseTimerRef = useRef<number | null>(null);

  // 活跃会话 ID 放在 ref 中，稳定的 transport 可以读取和更新它，
  // 不需要在每次选择会话时重新创建 transport。
  const threadIdRef = useRef<string | null>(null);
  const skipNextHistoryLoadRef = useRef<string | null>(null);
  threadIdRef.current = activeThreadId;
  modelOptionsRef.current = modelOptions;
  selectedModelRefRef.current = selectedModelRef;

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

  const rememberSelectedModelRef = useCallback((modelRef: string) => {
    selectedModelRefRef.current = modelRef;
    setSelectedModelRef(modelRef);
    if (modelRef) writeStoredModelRef(modelRef);
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
  const refreshThreadTitleAfterRun = useCallback((threadId: string) => {
    titleRefreshTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    titleRefreshTimersRef.current = TITLE_REFRESH_DELAYS_MS.map((delay) => window.setTimeout(() => {
      void getThread(threadId)
        .then(({ thread }) => {
          setThreads((current) => current.map((item) => (item.id === thread.id ? thread : item)));
          if (thread.title?.trim()) {
            titleRefreshTimersRef.current.forEach((timer) => window.clearTimeout(timer));
            titleRefreshTimersRef.current = [];
          }
        })
        .catch(() => {});
    }, delay));
  }, []);

  const refreshWorkspaceRoot = useCallback(() => {
    getRemoteFileInfo().then((info) => setWorkspaceRoot(info.workspaceRoot)).catch(() => setWorkspaceRoot(null));
  }, []);
  useEffect(refreshWorkspaceRoot, [refreshWorkspaceRoot]);

  useEffect(() => {
    let canceled = false;
    getLlmSettings()
      .then((settings) => {
        if (canceled) return;
        const options = llmOptionsFromSettings(settings);
        modelOptionsRef.current = options;
        setModelOptions(options);
        setSelectedModelRef((current) => {
          const stored = readStoredModelRef();
          const next =
            options.find((option) => option.ref === current)?.ref ??
            options.find((option) => option.ref === stored)?.ref ??
            options.find((option) => option.ref === settings.defaultModelRef)?.ref ??
            options[0]?.ref ??
            '';
          selectedModelRefRef.current = next;
          if (next) writeStoredModelRef(next);
          return next;
        });
      })
      .catch((err) => console.error('load llm settings failed', err));
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    readBrowserPushState()
      .then((state) => {
        if (!canceled) setPushState(state);
      })
      .catch((err) => {
        if (!canceled) {
          setPushState({
            supported: browserPushSupported(),
            permission: currentBrowserPushPermission(),
            subscribed: false,
            busy: false,
            error: (err as Error).message,
          });
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileSidebarOpen(false);
      setMobileRightPanelOpen(false);
      setMobileStatusCardOpen(false);
      return;
    }
  }, [isMobile]);

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
    titleRefreshTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const navigateSearch = useCallback(() => {
    flushPendingDraftSync();
    if (currentBrowserPath() !== '/search') window.history.pushState(null, '', '/search');
    setActiveView('search');
  }, [flushPendingDraftSync]);

  const handle = useMemo<ChatThreadHandle>(
    () => ({
      getThreadId: () => threadIdRef.current,
      getSelectedModelRef: () =>
        modelOptionsRef.current.some((option) => option.ref === selectedModelRefRef.current)
          ? selectedModelRefRef.current
          : '',
      setThreadId: (id) => {
        skipNextHistoryLoadRef.current = id;
        navigateChatRoute({ draft: '', threadId: id }, 'replace');
      },
      onThreadCreated: (thread) => {
        setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      },
      onRunFinished: (threadId) => refreshThreadTitleAfterRun(threadId),
      setActiveRunId,
    }),
    [navigateChatRoute, refreshThreadTitleAfterRun],
  );

  const transport = useMemo(() => createAiSdkChatTransport(handle), [handle]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({ transport });
  const busy = status === 'submitted' || status === 'streaming' || !!resumingRunId || !!reattachedRunId;

  useEffect(() => {
    if (!busy) setActiveRunId(null);
  }, [busy]);

  useEffect(() => {
    if (busy || !activeThreadId) return;
    let canceled = false;
    getThread(activeThreadId)
      .then(({ thread, runs }) => {
        if (canceled) return;
        setWaitingRun(waitingRunFrom(activeBranchRuns(runs, thread.active_run_id)));
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [busy, activeThreadId]);

  useEffect(() => {
    const path = buildChatPath(route);
    if (isSettingsPath()) {
      if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
      return;
    }
    if (activeView === 'search') {
      if (window.location.pathname !== '/search') window.history.replaceState(null, '', '/search');
      return;
    }
    if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
    // 仅首屏规范化旧地址或根路径，后续导航由 navigateChatRoute 负责。
  }, []);

  useEffect(() => {
    const onPopState = () => {
      flushPendingDraftSync();
      stop();
      if (isSettingsPath()) {
        const next = readChatRoute();
        const fallback = buildChatPath(next);
        if (currentBrowserPath() !== fallback) window.history.replaceState(null, '', fallback);
        setSettingsOpen(true);
        setActiveView('chat');
        setRoute(next);
        draftRef.current = next.draft;
        setComposerDraft(next.draft);
        return;
      }
      setSettingsOpen(false);
      setActiveView(activeViewFromPath());
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
      reattachedEventsRef.current = [];
      setReattachedRunId(null);
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
      .then(({ thread, runs, notices }) => {
        if (!canceled) {
          const branchRuns = activeBranchRuns(runs, thread.active_run_id);
          setMessages(runsToUiMessages(runs, thread.active_run_id, notices));
          setWaitingRun(waitingRunFrom(branchRuns));
          const liveRun = liveRunFrom(branchRuns);
          reattachedEventsRef.current = liveRun?.events ?? [];
          setReattachedRunId(liveRun?.id ?? null);
          if (liveRun) setActiveRunId(liveRun.id);
        }
      })
      .catch(() => {
        if (!canceled) {
          setMessages([]);
          reattachedEventsRef.current = [];
          setReattachedRunId(null);
        }
      });

    return () => {
      canceled = true;
    };
  }, [activeThreadId, setMessages]);

  useEffect(() => {
    if (!activeThreadId || !reattachedRunId) return;
    let canceled = false;
    let renderFrame = 0;

    const renderEvents = () => {
      renderFrame = 0;
      setMessages((current) => replaceAssistantMessage(current, reattachedRunId, reattachedEventsRef.current));
    };
    const refreshLiveRun = () => {
      void getThread(activeThreadId)
        .then(({ thread, runs, notices }) => {
          if (canceled) return;
          const branchRuns = activeBranchRuns(runs, thread.active_run_id);
          setMessages(runsToUiMessages(runs, thread.active_run_id, notices));
          setWaitingRun(waitingRunFrom(branchRuns));
          const liveRun = liveRunFrom(branchRuns);
          reattachedEventsRef.current = liveRun?.events ?? [];
          setReattachedRunId(liveRun?.id ?? null);
          setActiveRunId(liveRun?.id ?? null);
          if (!liveRun) refreshThreads();
        })
        .catch(() => {});
    };

    const unsubscribe = subscribeRun(
      reattachedRunId,
      (event) => {
        reattachedEventsRef.current = [...reattachedEventsRef.current, event];
        if (renderFrame) return;
        renderFrame = window.requestAnimationFrame(renderEvents);
      },
      refreshLiveRun,
      { replay: 'none' },
    );
    const interval = window.setInterval(refreshLiveRun, 2000);

    return () => {
      canceled = true;
      if (renderFrame) window.cancelAnimationFrame(renderFrame);
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [activeThreadId, reattachedRunId, refreshThreads, setMessages]);

  const pushNotificationState = !pushState.supported
    ? 'unsupported'
    : pushState.permission === 'denied'
      ? 'denied'
      : pushState.subscribed
        ? 'enabled'
        : pushState.permission === 'default'
          ? 'default'
          : 'disabled';

  async function togglePushNotifications() {
    if (pushState.busy) return;
    if (!pushState.supported) {
      notify({
        variant: 'error',
        title: '后台通知不可用',
        description: pushState.error ?? '当前浏览器不支持后台通知；移动端通常需要 HTTPS 页面。',
      });
      return;
    }
    if (pushState.permission === 'denied') {
      notify({
        variant: 'error',
        title: '后台通知被浏览器拒绝',
        description: pushState.error ?? '请在浏览器或系统设置中重新允许当前站点发送通知。',
      });
      return;
    }
    setPushState((current) => ({ ...current, busy: true, error: null }));
    try {
      const next = pushState.subscribed ? await disableBrowserPush() : await enableBrowserPush();
      setPushState(next);
      if (next.subscribed) {
        notify({ variant: 'success', title: '后台通知已开启', description: '对话完成后浏览器会推送通知。' });
      } else if (next.permission === 'granted') {
        notify({ variant: 'success', title: '后台通知已关闭' });
      } else {
        notify({ variant: 'info', title: '通知未开启', description: next.error ?? '浏览器没有授予通知权限。' });
      }
    } catch (err) {
      const message = (err as Error).message;
      setPushState((current) => ({ ...current, busy: false, error: message }));
      notify({ variant: 'error', title: '后台通知开启失败', description: message });
    }
  }

  function newChat() {
    stop();
    setEditingRunId(null);
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateChatRoute({ draft: '', threadId: null });
    setMessages([]);
  }

  function selectThread(id: string) {
    stop();
    setEditingRunId(null);
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateChatRoute({ draft: threadDraftsRef.current[id] ?? '', threadId: id });
  }

  function openSettings() {
    stop();
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    setSettingsOpen(true);
  }

  function openSearch() {
    stop();
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateSearch();
  }

  async function removeThread(id: string) {
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

  async function renameThread(id: string) {
    const current = threads.find((thread) => thread.id === id);
    const nextTitle = window.prompt('重命名会话', current?.title ?? '');
    if (nextTitle === null) return;
    await updateThread(id, { title: nextTitle });
    refreshThreads();
  }

  async function toggleThreadPin(id: string) {
    const current = threads.find((thread) => thread.id === id);
    await updateThread(id, { pinned: !current?.pinned_at });
    refreshThreads();
  }

  async function archiveThread(id: string) {
    stop();
    await updateThread(id, { archived: true });
    setThreads((current) => current.filter((thread) => thread.id !== id));
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
    void getThread(activeThreadId).then(({ thread, runs, notices }) => {
      const branchRuns = activeBranchRuns(runs, thread.active_run_id);
      setMessages(runsToUiMessages(runs, thread.active_run_id, notices));
      setWaitingRun(waitingRunFrom(branchRuns));
      const liveRun = liveRunFrom(branchRuns);
      reattachedEventsRef.current = liveRun?.events ?? [];
      setReattachedRunId(liveRun?.id ?? null);
      setActiveRunId(liveRun?.id ?? null);
    });
  }, [activeThreadId, setMessages]);

  const resumeWithAnswer = useCallback((runId: string, answer: AskUserAnswer) => {
    setWaitingRun(null);
    setReattachedRunId(null);
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

  const subscribeBranchedRun = useCallback((runId: string) => {
    setWaitingRun(null);
    setReattachedRunId(null);
    setResumingRunId(runId);
    setActiveRunId(runId);
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
        refreshThreads();
      },
    );
  }, [refreshActiveThread, refreshThreads, setMessages]);

  const switchRunBranch = useCallback((runId: string) => {
    if (!activeThreadId || busy) return;
    setEditingRunId(null);
    draftRef.current = '';
    setComposerDraft('');
    rememberThreadDraftRef(activeThreadId, '');
    replaceDraftRouteLater(activeThreadId, '');
    void updateThread(activeThreadId, { activeRunId: runId })
      .then(() => {
        refreshActiveThread();
        refreshThreads();
      })
      .catch((err) => console.error('switch branch failed', err));
  }, [activeThreadId, busy, rememberThreadDraftRef, refreshActiveThread, refreshThreads, replaceDraftRouteLater]);

  const regenerateRun = useCallback((runId: string, input?: string) => {
    if (busy) return;
    void branchRun(runId, input)
      .then(({ id }) => {
        refreshActiveThread();
        subscribeBranchedRun(id);
      })
      .catch((err) => {
        console.error('branch run failed', err);
        refreshActiveThread();
      });
  }, [busy, refreshActiveThread, subscribeBranchedRun]);

  const forkFromRun = useCallback((runId: string) => {
    if (busy) return;
    setEditingRunId(null);
    draftRef.current = '';
    setComposerDraft('');
    if (activeThreadId) {
      rememberThreadDraftRef(activeThreadId, '');
      replaceDraftRouteLater(activeThreadId, '');
    }
    void forkThreadFromRun(runId)
      .then(({ thread }) => {
        refreshThreads();
        navigateChatRoute({ draft: '', threadId: thread.id });
      })
      .catch((err) => {
        console.error('fork thread failed', err);
        refreshActiveThread();
      });
  }, [activeThreadId, busy, navigateChatRoute, rememberThreadDraftRef, refreshActiveThread, refreshThreads, replaceDraftRouteLater]);

  const editRunInput = useCallback((runId: string, currentText: string) => {
    if (busy) return;
    setAttachments([]);
    setEditingRunId(runId);
    draftRef.current = currentText;
    setComposerDraft(currentText);
    if (activeThreadId) {
      rememberThreadDraftRef(activeThreadId, currentText);
      scheduleThreadDraftSync();
    }
    replaceDraftRouteLater(activeThreadId, currentText);
  }, [activeThreadId, busy, rememberThreadDraftRef, replaceDraftRouteLater, scheduleThreadDraftSync]);

  const cancelEditRunInput = useCallback(() => {
    setEditingRunId(null);
    draftRef.current = '';
    setComposerDraft('');
    if (activeThreadId) {
      rememberThreadDraftRef(activeThreadId, '');
      scheduleThreadDraftSync();
    }
    replaceDraftRouteLater(activeThreadId, '');
  }, [activeThreadId, rememberThreadDraftRef, replaceDraftRouteLater, scheduleThreadDraftSync]);

  function send(text: string, modelRef: string) {
    if (waitingRun) return;
    const finalText = attachments.length
      ? [text.trim(), attachments.map(attachmentToken).join('\n')].filter(Boolean).join('\n\n')
      : text;
    rememberSelectedModelRef(modelRef);
    if (activeThreadId) rememberThreadDraft(activeThreadId, '');
    draftRef.current = '';
    setComposerDraft('');
    navigateChatRoute({ draft: '', threadId: activeThreadId }, 'replace');
    setAttachments([]);
    if (editingRunId) {
      const runId = editingRunId;
      setEditingRunId(null);
      regenerateRun(runId, finalText);
      return;
    }
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
    if (isMobile) {
      setMobileRightPanelOpen(true);
      setMobileStatusCardOpen(false);
    } else {
      setRightPanelOpen(true);
      setStatusCardOpen(false);
    }
  }

  function closeRightTab(tab: RightTabId) {
    setRightPanelTabs((current) => {
      const next = current.filter((item) => item !== tab);
      if (rightPanelMode === tab) {
        const currentIndex = current.indexOf(tab);
        const replacement = next[currentIndex] ?? next[currentIndex - 1] ?? next[0] ?? null;
        setRightPanelMode(replacement);
        if (!replacement) {
          setRightPanelOpen(false);
          setMobileRightPanelOpen(false);
        }
      }
      return next;
    });
  }

  function toggleRightPanel() {
    if (isMobile) {
      if (!rightPanelTabs.length) {
        setRightPanelTabs(['files']);
        setRightPanelMode('files');
      }
      setMobileRightPanelOpen((open) => !open);
      setMobileStatusCardOpen(false);
      return;
    }
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
    setReattachedRunId(null);
  }

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const title = activeThread?.title?.trim() || activeThread?.fallback_title?.trim() || (activeThreadId ? '会话' : '新会话');
  const rightPanelVisible = activeView === 'chat' && rightPanelOpen && !isMobile;
  const conversationRightPanelOpen = rightPanelVisible || rightPanelClosing;
  const threadHref = useCallback((threadId: string) => buildChatPath({ draft: '', threadId }), []);
  const newChatHref = buildChatPath({ draft: '', threadId: null });
  const mobileRightPanelWidth = Math.min(filesPanelWidth, viewportWidth, 520);

  useLayoutEffect(() => {
    const wasVisible = previousRightPanelVisibleRef.current;
    previousRightPanelVisibleRef.current = rightPanelVisible;
    if (rightPanelCloseTimerRef.current != null) {
      window.clearTimeout(rightPanelCloseTimerRef.current);
      rightPanelCloseTimerRef.current = null;
    }

    if (rightPanelVisible) {
      setRightPanelClosing(false);
      return;
    }

    if (!wasVisible) {
      setRightPanelClosing(false);
      return;
    }

    // 右侧栏宽度动画结束前继续占位，避免状态卡片提前跳出来。
    setRightPanelClosing(true);
    rightPanelCloseTimerRef.current = window.setTimeout(() => {
      setRightPanelClosing(false);
      rightPanelCloseTimerRef.current = null;
    }, RIGHT_PANEL_TRANSITION_MS);

    return () => {
      if (rightPanelCloseTimerRef.current != null) {
        window.clearTimeout(rightPanelCloseTimerRef.current);
        rightPanelCloseTimerRef.current = null;
      }
    };
  }, [rightPanelVisible]);

  return (
    <div className="app-main-surface flex h-full min-h-0 min-w-0 overflow-hidden">
      <div
        ref={sidebarFrameRef}
        className="sidebar-frame hidden h-full shrink-0 overflow-hidden md:block"
        style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
      >
        <Sidebar
          threads={threads}
          activeId={activeThreadId}
          activeView={activeView}
          settingsOpen={settingsOpen}
          width="100%"
          collapsed={sidebarCollapsed}
          newHref={newChatHref}
          searchHref="/search"
          threadHref={threadHref}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onNew={newChat}
          onSearch={openSearch}
          onSettings={openSettings}
          onSelect={selectThread}
          onRename={(id) => void renameThread(id)}
          onTogglePin={(id) => void toggleThreadPin(id)}
          onArchive={(id) => void archiveThread(id)}
          onDelete={(id) => void removeThread(id)}
        />
      </div>
      <div
        role="separator"
        aria-label="拖拽调整或收起会话列表"
        className="hidden h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-foreground/60 md:block"
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
      {activeView === 'search' ? (
        <SearchView
          threadHref={threadHref}
          onOpenThread={selectThread}
          mobile={isMobile}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
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
          modelOptions={modelOptions}
          selectedModelRef={selectedModelRef}
          editingRunId={editingRunId}
          onDraftChange={changeDraft}
          onModelChange={rememberSelectedModelRef}
          onSend={send}
          onCancel={cancelActiveRun}
          onCancelEdit={cancelEditRunInput}
          onToggleWide={() => setWide((v) => !v)}
          onRemoveAttachment={(path) => setAttachments((current) => current.filter((a) => a.path !== path))}
          rightPanelOpen={conversationRightPanelOpen}
          statusCardOpen={isMobile ? mobileStatusCardOpen : statusCardOpen}
          onToggleStatusCard={() => {
            if (isMobile) setMobileStatusCardOpen((open) => !open);
            else setStatusCardOpen((open) => !open);
          }}
          onToggleRightPanel={toggleRightPanel}
          onOpenShellPreview={(sessionId) => openRightTab(`shell:${sessionId}`)}
          onOpenSubagentPreview={(subagentId) => openRightTab(`subagent:${subagentId}`)}
          onOpenRemoteFiles={() => openRightTab('files')}
          onUploadLocal={uploadLocalAttachment}
          onOpenRemoteFile={openRemoteFile}
          onOpenThread={selectThread}
          onAskUserDraftChange={(runId, next) => setAskUserDrafts((current) => ({ ...current, [runId]: next }))}
          onAskUserSubmit={resumeWithAnswer}
          onAskUserCancel={cancelAskUser}
          onSwitchRunBranch={switchRunBranch}
          onEditRunInput={editRunInput}
          onForkFromRun={forkFromRun}
          mobile={isMobile}
          notificationBusy={pushState.busy}
          notificationError={pushState.error}
          notificationState={pushNotificationState}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          onTogglePushNotifications={() => void togglePushNotifications()}
        />
      )}
      {activeView === 'chat' && (
        <div
          role="separator"
          aria-label="调整右侧工作区宽度"
          className="h-full shrink-0 overflow-hidden bg-border/40 transition-[width,background-color] duration-200 ease-out hover:bg-foreground/60"
          style={{ width: rightPanelVisible ? 4 : 0 }}
          onPointerDown={(event) => {
            if (!rightPanelVisible) return;
            beginRightPanelResize(event, {
              width: filesPanelWidth,
              min: 460,
              max: Math.max(520, window.innerWidth - (sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth) - 360),
              onWidthChange: setFilesPanelWidth,
              onOpenChange: setRightPanelOpen,
            });
          }}
        />
      )}
      <div
        className="hidden h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out md:block"
        style={{ width: rightPanelVisible ? filesPanelWidth : 0 }}
        aria-hidden={!rightPanelVisible}
      >
        <RightSidebar
          open={rightPanelVisible}
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
      {isMobile && mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 flex animate-in fade-in-0 bg-background/70 duration-200 backdrop-blur-sm md:hidden">
          <button
            type="button"
            aria-label="关闭会话列表"
            className="absolute inset-0 cursor-default"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="relative h-full w-[min(86vw,340px)] animate-in slide-in-from-left-full duration-200 shadow-xl">
            <Sidebar
              threads={threads}
              activeId={activeThreadId}
              activeView={activeView}
              settingsOpen={settingsOpen}
              width="100%"
              collapsed={false}
              newHref={newChatHref}
              searchHref="/search"
              threadHref={threadHref}
              onToggleCollapsed={() => setMobileSidebarOpen(false)}
              onNew={newChat}
              onSearch={openSearch}
              onSettings={openSettings}
              onSelect={selectThread}
              onRename={(id) => void renameThread(id)}
              onTogglePin={(id) => void toggleThreadPin(id)}
              onArchive={(id) => void archiveThread(id)}
              onDelete={(id) => void removeThread(id)}
            />
          </div>
        </div>
      )}
      {isMobile && activeView === 'chat' && mobileRightPanelOpen && (
        <div className="fixed inset-0 z-50 flex animate-in fade-in-0 justify-end bg-background/70 duration-200 backdrop-blur-sm md:hidden">
          <button
            type="button"
            aria-label="关闭资源面板"
            className="absolute inset-0 cursor-default"
            onClick={() => setMobileRightPanelOpen(false)}
          />
          <div className="relative h-full w-full max-w-[520px] animate-in slide-in-from-right-full duration-200 shadow-xl">
            <RightSidebar
              open
              width={mobileRightPanelWidth}
              compact
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
              onClose={() => setMobileRightPanelOpen(false)}
              onAttach={addAttachment}
            />
          </div>
        </div>
      )}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          isMobile
            ? 'h-[100dvh] max-h-[100dvh] w-screen max-w-none rounded-none'
            : 'h-[760px] max-h-[calc(100vh-2rem)] w-[1120px] max-w-[calc(100vw-2rem)]',
        )}>
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>外观、用量统计、工具策略和数据源</DialogDescription>
          </DialogHeader>
          <SettingsView embedded onThreadsChanged={refreshThreads} onWorkspaceChanged={refreshWorkspaceRoot} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
