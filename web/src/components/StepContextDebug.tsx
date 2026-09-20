import type { StepContextSnapshotSummary, StepContextSnapshotView } from '@runforge/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getThreadStepContext, getThreadStepContexts } from '@/api';

interface StepContextDebugData {
  contexts: StepContextSnapshotSummary[];
  systemPrompt: string | null;
  details: Record<string, StepContextSnapshotView>;
  loading: boolean;
  error: string;
}

interface StepContextDebugState extends StepContextDebugData {
  loadContext: (stepId: string) => Promise<StepContextSnapshotView | null>;
}

const emptyData: StepContextDebugData = {
  contexts: [],
  systemPrompt: null,
  details: {},
  loading: false,
  error: '',
};
const emptyState: StepContextDebugState = {
  ...emptyData,
  loadContext: async () => null,
};
const StepContextDebugContext = createContext<StepContextDebugState>(emptyState);

export function StepContextDebugProvider({
  threadId,
  spaceId,
  active,
  refreshKey,
  children,
}: {
  threadId: string | null;
  spaceId: string | null;
  active: boolean;
  refreshKey: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<StepContextDebugData>(emptyData);
  const detailsRef = useRef<Record<string, StepContextSnapshotView>>({});
  const scopeRef = useRef('');

  const loadContext = useCallback(async (stepId: string) => {
    if (!threadId || !spaceId) return null;
    const cached = detailsRef.current[stepId];
    if (cached) return cached;
    const scope = `${spaceId}:${threadId}`;
    const detail = await getThreadStepContext(threadId, stepId, spaceId);
    if (scopeRef.current !== scope) return null;
    detailsRef.current = { ...detailsRef.current, [stepId]: detail };
    setState((current) => ({ ...current, details: detailsRef.current }));
    return detail;
  }, [spaceId, threadId]);

  useEffect(() => {
    scopeRef.current = threadId && spaceId ? `${spaceId}:${threadId}` : '';
    detailsRef.current = {};
    setState(emptyData);
  }, [spaceId, threadId]);

  useEffect(() => {
    if (!threadId || !spaceId) {
      return;
    }
    let canceled = false;
    const refresh = () => {
      setState((current) => ({ ...current, loading: current.contexts.length === 0, error: '' }));
      void getThreadStepContexts(threadId, spaceId)
        .then((response) => {
          if (!canceled) setState({
            contexts: response.contexts,
            systemPrompt: response.systemPrompt,
            details: detailsRef.current,
            loading: false,
            error: '',
          });
        })
        .catch((error: Error) => {
          if (!canceled) setState((current) => ({ ...current, loading: false, error: error.message }));
        });
    };
    refresh();
    const interval = active ? window.setInterval(refresh, 1500) : null;
    return () => {
      canceled = true;
      if (interval != null) window.clearInterval(interval);
    };
  }, [active, loadContext, refreshKey, spaceId, threadId]);

  const value = useMemo(() => ({ ...state, loadContext }), [loadContext, state]);
  return <StepContextDebugContext.Provider value={value}>{children}</StepContextDebugContext.Provider>;
}

export function useStepContextDebug(): StepContextDebugState {
  return useContext(StepContextDebugContext);
}
