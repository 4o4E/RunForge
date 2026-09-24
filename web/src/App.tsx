import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import {
  answerRun,
  branchRun,
  cancelRun,
  continueRun,
  createThread,
  forkThreadFromRun,
  getCurrentUser,
  getLlmSettingsOptions,
  getPageState,
  getRemoteFileInfo,
  getThread,
  listSpaces,
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
  type SpaceSummary,
  type Thread,
} from './api';
import { createAiSdkChatTransport, type ChatThreadHandle } from './transport/aiSdkChat';
import {
  appendPersistedRunUserMessage,
  assistantRunId,
  foldUiEventsToParts,
  generatedUserRunId,
  runsToUiMessages,
} from './history';
import { toUiEvent } from './transport/legacy';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { RightSidebar, type RightTabId } from './components/RightSidebar';
import { fileTabForPath } from './fileLinks';
import { SearchView } from './components/SearchView';
import type { ComposerAttachment } from './components/Composer';
import type { AskUserDraft } from './components/AskUserCard';
import { buildChatPath, buildSearchPath, currentBrowserPath, readChatRoute, type ChatRoute } from './router';
import { WorkspaceFileContextProvider } from './components/WorkspaceFileContext';
import { useNotifications } from './components/GlobalNotifications';
import { browserPushSupported, currentBrowserPushPermission, disableBrowserPush, enableBrowserPush, readBrowserPushState, type BrowserPushState } from './notifications';
import { attachmentToken, parseFileTokens } from './messageInput';

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
const THREAD_LIST_REFRESH_INTERVAL_MS = 5000;
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

function activeViewFromLocation(loc: Location = window.location): ActiveView {
  return new URLSearchParams(loc.search).get('view') === 'search' ? 'search' : 'chat';
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

function latestRunModelRef(runs: RunWithEvents[]): string {
  return [...runs].reverse().find((run) => run.model_ref?.trim())?.model_ref?.trim() ?? '';
}

function continuableRunFrom(runs: RunWithEvents[]): RunWithEvents | null {
  const latest = runs[runs.length - 1] ?? null;
  return latest?.status === 'error' ? latest : null;
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
  return value === 'files' || value === 'user-files'
    || (typeof value === 'string' && (value.startsWith('file:') || value.startsWith('user-file:') || value.startsWith('shell:') || value.startsWith('subagent:')));
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
}

const EMPTY_THREAD_PANEL_STATE: ThreadPanelState = {
  rightPanelOpen: false,
  rightPanelTabs: [],
  rightPanelMode: null,
};

function threadPanelStateValue(value: unknown): ThreadPanelState {
  const object = objectValue(value);
  const tabs = rightTabsValue(object.rightPanelTabs);
  const mode = isRightTabId(object.rightPanelMode) && tabs.includes(object.rightPanelMode) ? object.rightPanelMode : tabs[0] ?? null;
  return {
    rightPanelOpen: typeof object.rightPanelOpen === 'boolean' ? object.rightPanelOpen : false,
    rightPanelTabs: tabs,
    rightPanelMode: mode,
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
  const generatedUserCount = messages.filter((message) => generatedUserRunId(message) === runId).length;
  let boundaryCount = 0;
  let tailStart = 0;
  for (let eventIndex = 0; eventIndex < events.length && boundaryCount < generatedUserCount; eventIndex += 1) {
    const event = events[eventIndex];
    if (event.type !== 'external_input_applied' && event.type !== 'user_answer') continue;
    boundaryCount += 1;
    tailStart = eventIndex + 1;
  }
  const assistant = assistantMessageFromEvents(runId, events.slice(tailStart));
  // AI SDK 直播消息的 id 由 SDK 生成；恢复 ask_user 时必须用 data-run-id 对齐同一个 run。
  const exactIndex = messages.findIndex((message) => message.id === assistant.id);
  let index = exactIndex;
  if (index < 0) {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      if (assistantRunId(messages[messageIndex]) === runId) {
        index = messageIndex;
        break;
      }
    }
  }
  if (index >= 0) return messages.map((m, i) => (i === index ? assistant : m));
  return [...messages, assistant];
}

export function App() {
  const { notify } = useNotifications();
  const isMobile = useIsMobileViewport();
  const viewportWidth = useViewportWidth();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [spacesLoaded, setSpacesLoaded] = useState(false);
  const [route, setRoute] = useState<ChatRoute>(() => readChatRoute());
  const [activeView, setActiveView] = useState<ActiveView>(() => activeViewFromLocation());
  const [composerDraft, setComposerDraft] = useState(route.draft);
  const [wide, setWide] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelClosing, setRightPanelClosing] = useState(false);
  const [rightPanelTabs, setRightPanelTabs] = useState<RightTabId[]>([]);
  const [rightPanelMode, setRightPanelMode] = useState<RightTabId | null>(null);
  const [threadPanelStates, setThreadPanelStates] = useState<Record<string, ThreadPanelState>>({});
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileRightPanelOpen, setMobileRightPanelOpen] = useState(false);
  const [filesPanelWidth, setFilesPanelWidth] = useState(720);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [userFilesRoot, setUserFilesRoot] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<'owner' | 'admin' | 'member' | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [modelOptions, setModelOptions] = useState<LlmModelOption[]>([]);
  const [selectedModelRef, setSelectedModelRef] = useState(() => readStoredModelRef());
  const [activeThreadModelRef, setActiveThreadModelRef] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [reattachedRunId, setReattachedRunId] = useState<string | null>(null);
  const [waitingRun, setWaitingRun] = useState<{ id: string; spec: AskUserSpec } | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [continuableRunId, setContinuableRunId] = useState<string | null>(null);
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
  const activeSpace = spaces.find((space) => space.id === route.spaceId) ?? null;
  const readOnly = !activeSpace || activeSpace.mode === 'external';
  const sidebarFrameRef = useRef<HTMLDivElement>(null);
  const conversationContentRef = useRef<HTMLDivElement>(null);
  const previousPanelThreadIdRef = useRef(activeThreadId);
  const threadPanelStatesRef = useRef<Record<string, ThreadPanelState>>({});
  const threadDraftsRef = useRef<Record<string, string>>({});
  const draftRef = useRef(route.draft);
  const selectedModelRefRef = useRef(selectedModelRef);
  const spaceIdRef = useRef<string | null>(route.spaceId);
  const reattachedEventsRef = useRef<AgentEvent[]>([]);
  const draftSyncTimerRef = useRef<number | null>(null);
  const draftRouteTimerRef = useRef<number | null>(null);
  const titleRefreshTimersRef = useRef<number[]>([]);
  const previousRightPanelVisibleRef = useRef(false);
  const rightPanelCloseTimerRef = useRef<number | null>(null);
  const pendingSubmissionRef = useRef<{
    text: string;
    sentText: string;
    attachments: ComposerAttachment[];
    threadId: string | null;
  } | null>(null);

  // 活跃会话 ID 放在 ref 中，稳定的 transport 可以读取和更新它，
  // 不需要在每次选择会话时重新创建 transport。
  const threadIdRef = useRef<string | null>(null);
  const skipNextHistoryLoadRef = useRef<string | null>(null);
  threadIdRef.current = activeThreadId;
  spaceIdRef.current = route.spaceId;
  selectedModelRefRef.current = selectedModelRef;

  const currentThreadPanelState = useCallback((): ThreadPanelState => ({
    rightPanelOpen,
    rightPanelTabs,
    rightPanelMode: rightPanelMode && rightPanelTabs.includes(rightPanelMode) ? rightPanelMode : rightPanelTabs[0] ?? null,
  }), [rightPanelMode, rightPanelOpen, rightPanelTabs]);

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
      const path = buildChatPath({ draft: draftText, spaceId: spaceIdRef.current, threadId });
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
    const spaceId = route.spaceId;
    if (!spaceId) {
      setThreads([]);
      return;
    }
    void listThreads({ spaceId })
      .then((next) => {
        if (spaceIdRef.current === spaceId) setThreads(next);
      })
      .catch((error) => console.error('refresh thread list failed', error));
  }, [route.spaceId]);
  useEffect(() => {
    setThreads([]);
    refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    const refreshVisibleList = () => {
      if (document.visibilityState === 'visible') refreshThreads();
    };
    const interval = window.setInterval(refreshVisibleList, THREAD_LIST_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshVisibleList);
    document.addEventListener('visibilitychange', refreshVisibleList);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisibleList);
      document.removeEventListener('visibilitychange', refreshVisibleList);
    };
  }, [refreshThreads]);

  useEffect(() => {
    let canceled = false;
    listSpaces()
      .then(({ spaces: visibleSpaces }) => {
        if (!canceled) setSpaces(visibleSpaces);
      })
      .catch(() => {
        if (!canceled) setSpaces([]);
      })
      .finally(() => {
        if (!canceled) setSpacesLoaded(true);
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!spacesLoaded) return;
    // 会话 URL 只携带 th_ ID；详情接口通过登录身份校验后返回所属空间。
    if (route.threadId && route.spaceId === null) return;
    const selected = spaces.find((space) => space.id === route.spaceId) ?? null;
    if (selected && !(selected.mode === 'external' && activeView === 'search')) return;
    const fallback = selected ?? spaces.find((space) => space.isDefault) ?? spaces[0] ?? null;
    const nextView: ActiveView = fallback?.mode === 'web' && activeView === 'search' ? 'search' : 'chat';
    const nextRoute: ChatRoute = {
      draft: route.draft,
      spaceId: fallback?.id ?? null,
      threadId: selected || route.spaceId === null ? route.threadId : null,
    };
    setRoute(nextRoute);
    setActiveView(nextView);
    const path = nextView === 'search'
      ? buildSearchPath(nextRoute.spaceId, new URLSearchParams(window.location.search).get('q') ?? '')
      : buildChatPath(nextRoute);
    if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
  }, [activeView, route.draft, route.spaceId, route.threadId, spaces, spacesLoaded]);

  const refreshThreadTitleAfterRun = useCallback((threadId: string) => {
    titleRefreshTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    titleRefreshTimersRef.current = TITLE_REFRESH_DELAYS_MS.map((delay) => window.setTimeout(() => {
      void getThread(threadId, { spaceId: spaceIdRef.current })
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

  useEffect(() => {
    let canceled = false;
    setWorkspaceRoot(null);
    if (!activeThreadId) return () => {
      canceled = true;
    };
    getRemoteFileInfo(activeThreadId)
      .then((info) => {
        if (!canceled) setWorkspaceRoot(info.workspaceRoot);
      })
      .catch(() => {
        if (!canceled) setWorkspaceRoot(null);
      });
    return () => {
      canceled = true;
    };
  }, [activeThreadId]);

  useEffect(() => {
    let canceled = false;
    getRemoteFileInfo('@user')
      .then((info) => { if (!canceled) setUserFilesRoot(info.workspaceRoot); })
      .catch(() => { if (!canceled) setUserFilesRoot(null); });
    return () => { canceled = true; };
  }, []);

  // 只用来决定要不要在侧边栏显示"管理后台"入口；失败时静默保持 null(不显示入口)。
  useEffect(() => {
    let canceled = false;
    getCurrentUser()
      .then((user) => {
        if (!canceled) setCurrentUserRole(user.role);
      })
      .catch(() => {
        if (!canceled) setCurrentUserRole(null);
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    getLlmSettingsOptions()
      .then((settings) => {
        if (canceled) return;
        const options = settings.models;
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
    setAttachments([]);
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
    if (!spaceIdRef.current) return;
    flushPendingDraftSync();
    const path = buildSearchPath(spaceIdRef.current);
    if (currentBrowserPath() !== path) window.history.pushState(null, '', path);
    setActiveView('search');
  }, [flushPendingDraftSync]);

  const handle = useMemo<ChatThreadHandle>(
    () => ({
      getThreadId: () => threadIdRef.current,
      getSpaceId: () => spaceIdRef.current,
      // 已选模型若在其他页面被停用，仍交给服务端明确拒绝，不能静默改用空间默认模型。
      getSelectedModelRef: () => selectedModelRefRef.current,
      setThreadId: (id) => {
        threadIdRef.current = id;
        skipNextHistoryLoadRef.current = id;
        navigateChatRoute({ draft: '', spaceId: spaceIdRef.current, threadId: id }, 'replace');
      },
      onThreadCreated: (thread) => {
        if (pendingSubmissionRef.current) pendingSubmissionRef.current.threadId = thread.id;
        setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      },
      onRunStarted: () => {
        pendingSubmissionRef.current = null;
        refreshThreads();
      },
      onRunFinished: (threadId) => {
        refreshThreads();
        refreshThreadTitleAfterRun(threadId);
        // Debug 原始载荷和最终 collapsed 状态来自持久化消息，run 收口后重载一次。
        setHistoryRevision((revision) => revision + 1);
      },
      setActiveRunId,
    }),
    [navigateChatRoute, refreshThreadTitleAfterRun, refreshThreads],
  );

  const transport = useMemo(() => createAiSdkChatTransport(handle), [handle]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport,
    onError: (error) => {
      const pending = pendingSubmissionRef.current;
      pendingSubmissionRef.current = null;
      notify({
        variant: 'error',
        title: pending ? '消息未发送' : '对话连接出错',
        description: error.message,
        durationMs: 12_000,
      });
      if (!pending || pending.threadId !== threadIdRef.current) return;
      setMessages((current) => {
        const last = current.at(-1);
        const lastText = last?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
        return last?.role === 'user' && lastText === pending.sentText ? current.slice(0, -1) : current;
      });
      draftRef.current = pending.text;
      setComposerDraft(pending.text);
      setAttachments(pending.attachments);
      if (pending.threadId) rememberThreadDraftRef(pending.threadId, pending.text);
      replaceDraftRouteLater(pending.threadId, pending.text);
    },
  });
  const busy = status === 'submitted' || status === 'streaming' || !!resumingRunId || !!reattachedRunId;

  useEffect(() => {
    if (!busy) setActiveRunId(null);
  }, [busy]);

  useEffect(() => {
    if (busy || !activeThreadId) return;
    let canceled = false;
    getThread(activeThreadId, { spaceId: route.spaceId })
      .then(({ thread, runs }) => {
        if (canceled) return;
        setWaitingRun(waitingRunFrom(activeBranchRuns(runs, thread.active_run_id)));
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [busy, activeThreadId, route.spaceId]);

  useEffect(() => {
    const path = buildChatPath(route);
    if (activeView === 'search') {
      const searchPath = buildSearchPath(route.spaceId, new URLSearchParams(window.location.search).get('q') ?? '');
      if (currentBrowserPath() !== searchPath) window.history.replaceState(null, '', searchPath);
      return;
    }
    if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
    // 仅首屏规范化根路径，后续导航由 navigateChatRoute 负责。
  }, []);

  useEffect(() => {
    const onPopState = () => {
      flushPendingDraftSync();
      stop();
      setActiveView(activeViewFromLocation());
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
      setContinuableRunId(null);
      setActiveThreadModelRef('');
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

    getThread(activeThreadId, { debug: debugMode, spaceId: route.spaceId })
      .then(({ thread, runs, notices, context_messages }) => {
        if (!canceled) {
          setRoute((current) => (
            current.threadId === thread.id && current.spaceId !== thread.space_id
              ? { ...current, spaceId: thread.space_id }
              : current
          ));
          setThreads((current) => {
            const index = current.findIndex((item) => item.id === thread.id);
            if (index < 0) return [...current, thread];
            const next = [...current];
            next[index] = thread;
            return next;
          });
          const branchRuns = activeBranchRuns(runs, thread.active_run_id);
          setActiveThreadModelRef(latestRunModelRef(branchRuns));
          setMessages(runsToUiMessages(runs, thread.active_run_id, notices, context_messages, thread.space_id));
          setWaitingRun(readOnly ? null : waitingRunFrom(branchRuns));
          const liveRun = liveRunFrom(branchRuns);
          const continuableRun = readOnly ? null : continuableRunFrom(branchRuns);
          reattachedEventsRef.current = liveRun?.events ?? [];
          setReattachedRunId(liveRun?.id ?? null);
          setActiveRunId(liveRun?.id ?? null);
          setContinuableRunId(continuableRun?.id ?? null);
        }
      })
      .catch(() => {
        if (!canceled) {
          setMessages([]);
          reattachedEventsRef.current = [];
          setReattachedRunId(null);
          setActiveRunId(null);
          setContinuableRunId(null);
          setActiveThreadModelRef('');
          if (route.spaceId === null && spacesLoaded) {
            const fallback = spaces.find((space) => space.isDefault) ?? spaces[0] ?? null;
            const nextRoute: ChatRoute = {
              draft: route.draft,
              spaceId: fallback?.id ?? null,
              threadId: null,
            };
            setRoute(nextRoute);
            const path = buildChatPath(nextRoute);
            if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
          }
        }
      });

    return () => {
      canceled = true;
    };
  }, [activeThreadId, debugMode, historyRevision, readOnly, route.draft, route.spaceId, setMessages, spaces, spacesLoaded]);

  useEffect(() => {
    if (!activeThreadId || !reattachedRunId) return;
    let canceled = false;
    let renderFrame = 0;

    const renderEvents = () => {
      renderFrame = 0;
      setMessages((current) => replaceAssistantMessage(current, reattachedRunId, reattachedEventsRef.current));
    };
    const refreshLiveRun = () => {
      void getThread(activeThreadId, { debug: debugMode, spaceId: route.spaceId })
        .then(({ thread, runs, notices, context_messages }) => {
          if (canceled) return;
          const branchRuns = activeBranchRuns(runs, thread.active_run_id);
          setActiveThreadModelRef(latestRunModelRef(branchRuns));
          setMessages(runsToUiMessages(runs, thread.active_run_id, notices, context_messages, thread.space_id));
          setWaitingRun(readOnly ? null : waitingRunFrom(branchRuns));
          const liveRun = liveRunFrom(branchRuns);
          const continuableRun = readOnly ? null : continuableRunFrom(branchRuns);
          reattachedEventsRef.current = liveRun?.events ?? [];
          setReattachedRunId(liveRun?.id ?? null);
          setActiveRunId(liveRun?.id ?? null);
          setContinuableRunId(continuableRun?.id ?? null);
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
  }, [activeThreadId, debugMode, readOnly, reattachedRunId, refreshThreads, route.spaceId, setMessages]);

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
    if (readOnly || !route.spaceId) return;
    stop();
    setEditingRunId(null);
    setContinuableRunId(null);
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateChatRoute({ draft: '', spaceId: route.spaceId, threadId: null });
    setMessages([]);
  }

  function selectThread(id: string) {
    stop();
    setEditingRunId(null);
    setContinuableRunId(null);
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateChatRoute({ draft: threadDraftsRef.current[id] ?? '', spaceId: route.spaceId, threadId: id });
  }

  function selectSpace(spaceId: string) {
    if (spaceId === route.spaceId) return;
    stop();
    setEditingRunId(null);
    setWaitingRun(null);
    setContinuableRunId(null);
    setReattachedRunId(null);
    setActiveRunId(null);
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateChatRoute({ draft: '', spaceId, threadId: null });
    setMessages([]);
  }

  function openSearch() {
    stop();
    setContinuableRunId(null);
    setMobileSidebarOpen(false);
    if (activeThreadId) rememberThreadDraft(activeThreadId, draftRef.current);
    navigateSearch();
  }

  async function renameThread(id: string) {
    if (readOnly) return;
    const current = threads.find((thread) => thread.id === id);
    const nextTitle = window.prompt('重命名会话', current?.title ?? '');
    if (nextTitle === null) return;
    await updateThread(id, { title: nextTitle });
    refreshThreads();
  }

  async function toggleThreadPin(id: string) {
    if (readOnly) return;
    const current = threads.find((thread) => thread.id === id);
    await updateThread(id, { pinned: !current?.pinned_at });
    refreshThreads();
  }

  async function archiveThread(id: string) {
    if (readOnly) return;
    stop();
    await updateThread(id, { archived: true });
    setThreads((current) => current.filter((thread) => thread.id !== id));
    if (activeThreadId === id) {
      setContinuableRunId(null);
      navigateChatRoute({ draft: '', spaceId: route.spaceId, threadId: null });
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
    void getThread(activeThreadId, { debug: debugMode, spaceId: route.spaceId }).then(({ thread, runs, notices, context_messages }) => {
      const branchRuns = activeBranchRuns(runs, thread.active_run_id);
      setActiveThreadModelRef(latestRunModelRef(branchRuns));
      setMessages(runsToUiMessages(runs, thread.active_run_id, notices, context_messages, thread.space_id));
      setWaitingRun(readOnly ? null : waitingRunFrom(branchRuns));
      const liveRun = liveRunFrom(branchRuns);
      const continuableRun = readOnly ? null : continuableRunFrom(branchRuns);
      reattachedEventsRef.current = liveRun?.events ?? [];
      setReattachedRunId(liveRun?.id ?? null);
      setActiveRunId(liveRun?.id ?? null);
      setContinuableRunId(continuableRun?.id ?? null);
    });
  }, [activeThreadId, debugMode, readOnly, route.spaceId, setMessages]);

  const resumeWithAnswer = useCallback((runId: string, answer: AskUserAnswer) => {
    setWaitingRun(null);
    setReattachedRunId(null);
    setResumingRunId(runId);
    setActiveRunId(runId);
    void answerRun(runId, answer)
      .then(({ userMessage }) => {
        setMessages((current) => appendPersistedRunUserMessage(current, runId, userMessage, answer));
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
        setContinuableRunId(null);
        refreshThreads();
      },
    );
  }, [refreshActiveThread, refreshThreads, setMessages]);

  const continueFailedRun = useCallback(() => {
    const runId = continuableRunId;
    if (!runId || busy) return;
    setWaitingRun(null);
    setReattachedRunId(null);
    setResumingRunId(runId);
    setActiveRunId(runId);
    void continueRun(runId)
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
            setContinuableRunId(null);
            refreshThreads();
          },
        );
      })
      .catch((err) => {
        console.error('continue run failed', err);
        setResumingRunId(null);
        setActiveRunId(null);
        refreshActiveThread();
      });
  }, [busy, continuableRunId, refreshActiveThread, refreshThreads, setMessages]);

  const switchRunBranch = useCallback((runId: string) => {
    if (!activeThreadId || busy) return;
    setEditingRunId(null);
    setAttachments([]);
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
        navigateChatRoute({ draft: '', spaceId: thread.space_id, threadId: thread.id });
      })
      .catch((err) => {
        console.error('fork thread failed', err);
        refreshActiveThread();
      });
  }, [activeThreadId, busy, navigateChatRoute, rememberThreadDraftRef, refreshActiveThread, refreshThreads, replaceDraftRouteLater]);

  const editRunInput = useCallback((runId: string, currentText: string) => {
    if (busy) return;
    const parsed = parseFileTokens(currentText);
    setAttachments(parsed.files.map((file) => ({
      kind: file.kind === 'local' ? 'local' : 'remote',
      path: file.path,
      name: file.name || file.path,
      size: file.size,
    })));
    setEditingRunId(runId);
    draftRef.current = parsed.text;
    setComposerDraft(parsed.text);
    if (activeThreadId) {
      rememberThreadDraftRef(activeThreadId, parsed.text);
      scheduleThreadDraftSync();
    }
    replaceDraftRouteLater(activeThreadId, parsed.text);
  }, [activeThreadId, busy, rememberThreadDraftRef, replaceDraftRouteLater, scheduleThreadDraftSync]);

  const cancelEditRunInput = useCallback(() => {
    setEditingRunId(null);
    setAttachments([]);
    draftRef.current = '';
    setComposerDraft('');
    if (activeThreadId) {
      rememberThreadDraftRef(activeThreadId, '');
      scheduleThreadDraftSync();
    }
    replaceDraftRouteLater(activeThreadId, '');
  }, [activeThreadId, rememberThreadDraftRef, replaceDraftRouteLater, scheduleThreadDraftSync]);

  function send(text: string, modelRef: string) {
    if (readOnly || waitingRun || !route.spaceId) return;
    const finalText = attachments.length
      ? [text.trim(), attachments.map(attachmentToken).join('\n')].filter(Boolean).join('\n\n')
      : text;
    rememberSelectedModelRef(modelRef);
    setContinuableRunId(null);
    if (!editingRunId) pendingSubmissionRef.current = { text, sentText: finalText, attachments, threadId: activeThreadId };
    if (activeThreadId) rememberThreadDraft(activeThreadId, '');
    draftRef.current = '';
    setComposerDraft('');
    navigateChatRoute({ draft: '', spaceId: route.spaceId, threadId: activeThreadId }, 'replace');
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
    let targetThreadId = threadIdRef.current;
    if (!targetThreadId) {
      const spaceId = spaceIdRef.current;
      if (!spaceId) throw new Error('请先选择空间');
      const thread = await createThread(undefined, spaceId);
      targetThreadId = thread.id;
      handle.setThreadId(thread.id);
      handle.onThreadCreated(thread);
    }
    const uploaded = await uploadLocalFile(path, file, targetThreadId);
    if (threadIdRef.current !== targetThreadId) {
      throw new Error('上传期间会话已切换，文件仍保存在原会话，请在当前会话重新上传');
    }
    addAttachment({ kind: 'local', path: uploaded.path, name: file.name, size: uploaded.size });
  }

  function openRightTab(tab: RightTabId) {
    setRightPanelTabs((current) => current.includes(tab) ? current : [...current, tab]);
    setRightPanelMode(tab);
    if (isMobile) {
      setMobileRightPanelOpen(true);
    } else {
      setRightPanelOpen(true);
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
      setMobileRightPanelOpen((open) => !open);
      return;
    }
    setRightPanelOpen((open) => !open);
  }

  async function openRemoteFile(path: string) {
    try {
      let root = userFilesRoot;
      if (path.startsWith('/u/') && !root) {
        root = (await getRemoteFileInfo('@user')).workspaceRoot;
        setUserFilesRoot(root);
      }
      openRightTab(fileTabForPath(path, workspaceRoot, root));
    } catch (err) {
      notify({ variant: 'error', title: '无法打开文件链接', description: (err as Error).message });
    }
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
  const title = activeThread?.title?.trim()
    || activeThread?.fallback_title?.trim()
    || (activeThreadId ? '会话' : activeSpace?.mode === 'external' ? '外部任务' : '新会话');
  const rightPanelVisible = activeView === 'chat' && rightPanelOpen && !isMobile;
  const conversationRightPanelOpen = rightPanelVisible || rightPanelClosing;
  const threadHref = useCallback(
    (threadId: string) => buildChatPath({ draft: '', spaceId: route.spaceId, threadId }),
    [route.spaceId],
  );
  const newChatHref = buildChatPath({ draft: '', spaceId: route.spaceId, threadId: null });
  const searchHref = buildSearchPath(route.spaceId);
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

    // 右侧栏宽度动画结束前继续占位，避免对话区提前横向跳动。
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
    <WorkspaceFileContextProvider threadId={activeThreadId}>
    <div className="app-main-surface flex h-full min-h-0 min-w-0 overflow-hidden">
      <div
        ref={sidebarFrameRef}
        className="sidebar-frame hidden h-full shrink-0 overflow-hidden md:block"
        style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
      >
        <Sidebar
          spaces={spaces}
          activeSpaceId={route.spaceId}
          readOnly={readOnly}
          threads={threads}
          activeId={activeThreadId}
          activeView={activeView}
          width="100%"
          collapsed={sidebarCollapsed}
          newHref={newChatHref}
          searchHref={searchHref}
          threadHref={threadHref}
          showAdminEntry={currentUserRole === 'owner' || currentUserRole === 'admin'}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onSelectSpace={selectSpace}
          onNew={newChat}
          onSearch={openSearch}
          onSelect={selectThread}
          onRename={(id) => void renameThread(id)}
          onTogglePin={(id) => void toggleThreadPin(id)}
          onArchive={(id) => void archiveThread(id)}
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
      {activeView === 'search' && route.spaceId ? (
        <SearchView
          spaceId={route.spaceId}
          threadHref={threadHref}
          onOpenThread={selectThread}
          mobile={isMobile}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
      ) : (
        <ChatView
          title={title}
          space={activeSpace}
          thread={activeThread ?? null}
          readOnly={readOnly}
          messages={messages}
          busy={busy}
          waitingQuestion={waitingRun?.spec.question ?? null}
          draft={composerDraft}
          wide={wide}
          workspaceRoot={workspaceRoot}
          contentRef={conversationContentRef}
          askUserDrafts={askUserDrafts}
          attachments={attachments}
          modelOptions={modelOptions}
          selectedModelRef={readOnly ? activeThreadModelRef : selectedModelRef}
          editingRunId={editingRunId}
          canContinueRun={!!continuableRunId}
          continuingRun={!!continuableRunId && resumingRunId === continuableRunId}
          onDraftChange={changeDraft}
          onModelChange={rememberSelectedModelRef}
          onSend={send}
          onCancel={cancelActiveRun}
          onContinueRun={continueFailedRun}
          onCancelEdit={cancelEditRunInput}
          onToggleWide={() => setWide((v) => !v)}
          debugMode={debugMode}
          onToggleDebug={() => setDebugMode((enabled) => !enabled)}
          canInspectSpace={currentUserRole === 'owner' || currentUserRole === 'admin'}
          onRemoveAttachment={(path) => setAttachments((current) => current.filter((a) => a.path !== path))}
          rightPanelOpen={conversationRightPanelOpen}
          onToggleRightPanel={toggleRightPanel}
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
          key={activeThreadId ?? 'default-workspace'}
          open={rightPanelVisible}
          width={filesPanelWidth}
          tabs={rightPanelTabs}
          activeTab={rightPanelMode}
          threadId={activeThreadId}
          spaceId={route.spaceId}
          readOnly={readOnly}
          workspaceRoot={workspaceRoot}
          onTabChange={setRightPanelMode}
          onOpenFileBrowser={() => openRightTab('files')}
          onOpenUserFiles={() => openRightTab('user-files')}
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
              spaces={spaces}
              activeSpaceId={route.spaceId}
              readOnly={readOnly}
              threads={threads}
              activeId={activeThreadId}
              activeView={activeView}
              width="100%"
              collapsed={false}
              newHref={newChatHref}
              searchHref={searchHref}
              threadHref={threadHref}
              showAdminEntry={currentUserRole === 'owner' || currentUserRole === 'admin'}
              onToggleCollapsed={() => setMobileSidebarOpen(false)}
              onSelectSpace={selectSpace}
              onNew={newChat}
              onSearch={openSearch}
              onSelect={selectThread}
              onRename={(id) => void renameThread(id)}
              onTogglePin={(id) => void toggleThreadPin(id)}
              onArchive={(id) => void archiveThread(id)}
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
              key={activeThreadId ?? 'default-workspace'}
              open
              width={mobileRightPanelWidth}
              compact
              tabs={rightPanelTabs}
              activeTab={rightPanelMode}
              threadId={activeThreadId}
              spaceId={route.spaceId}
              readOnly={readOnly}
              workspaceRoot={workspaceRoot}
              onTabChange={setRightPanelMode}
              onOpenFileBrowser={() => openRightTab('files')}
              onOpenUserFiles={() => openRightTab('user-files')}
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
    </div>
    </WorkspaceFileContextProvider>
  );
}
