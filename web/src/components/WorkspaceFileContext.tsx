import { createContext, useContext, type ReactNode } from 'react';
import type { FileShareAccess } from '@/api';

interface WorkspaceFileContextValue {
  threadId: string | null;
  shareAccess?: FileShareAccess;
}

const WorkspaceFileContext = createContext<WorkspaceFileContextValue>({ threadId: null });

export function WorkspaceFileContextProvider({
  threadId,
  shareAccess,
  children,
}: WorkspaceFileContextValue & { children: ReactNode }) {
  return (
    <WorkspaceFileContext.Provider value={{ threadId, shareAccess }}>
      {children}
    </WorkspaceFileContext.Provider>
  );
}

export function useWorkspaceFileContext(): WorkspaceFileContextValue {
  return useContext(WorkspaceFileContext);
}
