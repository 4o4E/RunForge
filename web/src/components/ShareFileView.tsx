import { useMemo } from 'react';
import type { FileShareAccess } from '@/api';
import { RemoteFilesPanel } from './RemoteFilesPanel';
import { WorkspaceFileContextProvider } from './WorkspaceFileContext';

function readShareParams(): { path: string; share: FileShareAccess } | null {
  const params = new URLSearchParams(window.location.search);
  const path = params.get('path')?.trim() ?? '';
  const tenant = params.get('tenant')?.trim() ?? '';
  const user = params.get('user')?.trim() ?? '';
  const expires = params.get('expires')?.trim() ?? '';
  const sig = params.get('sig')?.trim() ?? '';
  const threadId = params.get('threadId')?.trim() || undefined;
  if (!path || !tenant || !user || !expires || !sig) return null;
  return { path, share: { tenant, user, threadId, expires, sig } };
}

export function ShareFileView() {
  const params = useMemo(readShareParams, []);
  if (!params) {
    return (
      <div className="app-main-surface flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
        分享链接缺少文件路径、身份或签名参数。
      </div>
    );
  }

  return (
    <WorkspaceFileContextProvider threadId={params.share.threadId ?? null} shareAccess={params.share}>
      <main className="app-main-surface h-full min-h-0 overflow-hidden">
        <RemoteFilesPanel
          open
          embedded
          width={0}
          previewPath={params.path}
          shareAccess={params.share}
          showAttach={false}
          showShare={false}
          showBrowser={false}
          onClose={() => {}}
          onAttach={() => {}}
        />
      </main>
    </WorkspaceFileContextProvider>
  );
}
