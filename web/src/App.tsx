import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createThread,
  getThread,
  listThreads,
  startRun,
  subscribeRun,
  type AgentEvent,
  type RunWithEvents,
  type Thread,
} from './api';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import type { Turn } from './components/MessageList';
import { useThemeCtx } from './theme';

function runsToTurns(runs: RunWithEvents[]): Turn[] {
  return runs.map((r) => ({
    input: r.input,
    events: r.events,
    running: r.status === 'running' || r.status === 'pending',
  }));
}

export function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const { theme, toggle: toggleTheme } = useThemeCtx();
  const unsubRef = useRef<(() => void) | null>(null);

  const refreshThreads = useCallback(() => {
    listThreads().then(setThreads).catch(() => {});
  }, []);

  useEffect(refreshThreads, [refreshThreads]);

  function newChat() {
    unsubRef.current?.();
    setActiveThreadId(null);
    setTurns([]);
    setRunning(false);
  }

  async function selectThread(id: string) {
    unsubRef.current?.();
    setRunning(false);
    setActiveThreadId(id);
    try {
      const { runs } = await getThread(id);
      setTurns(runsToTurns(runs));
    } catch {
      setTurns([]);
    }
  }

  function appendEvent(e: AgentEvent) {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, e] };
      return next;
    });
  }

  function finishLastTurn() {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], running: false };
      return next;
    });
    setRunning(false);
  }

  async function send(text: string) {
    setRunning(true);
    setTurns((prev) => [...prev, { input: text, events: [], running: true }]);

    try {
      let threadId = activeThreadId;
      if (!threadId) {
        const thread = await createThread(text.slice(0, 40));
        threadId = thread.id;
        setActiveThreadId(threadId);
        refreshThreads();
      }
      const { id } = await startRun(threadId, text);
      unsubRef.current = subscribeRun(id, appendEvent, finishLastTurn);
    } catch (err) {
      appendEvent({ type: 'error', step: 0, message: (err as Error).message });
      finishLastTurn();
    }
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
      <ChatView title={title} turns={turns} running={running} onSend={send} />
    </div>
  );
}
