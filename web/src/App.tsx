import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { getThread, listThreads, type Thread } from './api';
import { createAiSdkChatTransport, type ChatThreadHandle } from './transport/aiSdkChat';
import { runsToUiMessages } from './history';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { buildChatPath, currentBrowserPath, readChatRoute, type ChatRoute } from './router';
import { useThemeCtx } from './theme';

export function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [route, setRoute] = useState<ChatRoute>(() => readChatRoute());
  const [draft, setDraft] = useState(route.draft);
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

  const navigateChatRoute = useCallback((next: ChatRoute, mode: 'push' | 'replace' = 'push') => {
    const path = buildChatPath(next);
    if (currentBrowserPath() !== path) {
      if (mode === 'replace') window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    setRoute(next);
    setDraft(next.draft);
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
    if (currentBrowserPath() !== path) window.history.replaceState(null, '', path);
    // 仅首屏规范化旧地址或根路径，后续导航由 navigateChatRoute 负责。
  }, []);

  useEffect(() => {
    const onPopState = () => {
      stop();
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
    navigateChatRoute({ draft: '', threadId: null });
    setMessages([]);
  }

  function selectThread(id: string) {
    stop();
    navigateChatRoute({ draft: '', threadId: id });
  }

  function changeDraft(text: string) {
    navigateChatRoute({ draft: text, threadId: activeThreadId }, 'replace');
  }

  function send(text: string) {
    navigateChatRoute({ draft: '', threadId: activeThreadId }, 'replace');
    void sendMessage({ text });
  }

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const title = activeThread?.title ?? (activeThreadId ? '会话' : '新会话');

  return (
    <div className="flex h-full">
      <Sidebar
        threads={threads}
        activeId={activeThreadId}
        theme={theme}
        onToggleTheme={toggleTheme}
        onNew={newChat}
        onSelect={selectThread}
      />
      <ChatView
        title={title}
        messages={messages}
        busy={busy}
        draft={draft}
        onDraftChange={changeDraft}
        onSend={send}
      />
    </div>
  );
}
