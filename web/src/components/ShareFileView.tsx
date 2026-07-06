import { useMemo } from 'react';
import type { FileShareAccess } from '@/api';
import { RemoteFilesPanel } from './RemoteFilesPanel';

function readShareParams(): { path: string; share: FileShareAccess } | null {
  const params = new URLSearchParams(window.location.search);
  const path = params.get('path')?.trim() ?? '';
  const expires = params.get('expires')?.trim() ?? '';
  const sig = params.get('sig')?.trim() ?? '';
  if (!path || !expires || !sig) return null;
  return { path, share: { expires, sig } };
}

export function ShareFileView() {
  const params = useMemo(readShareParams, []);
  if (!params) {
    return (
      <div className="app-main-surface flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
        分享链接缺少文件路径或签名参数。
      </div>
    );
  }

  return (
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
  );
}
