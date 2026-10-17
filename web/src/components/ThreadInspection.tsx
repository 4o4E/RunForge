import { useEffect, useState, type ReactNode } from 'react';
import { getThreadInspection, type Thread, type ThreadInspection } from '@/api';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { formatFileDate, formatFileSize } from '@/lib/fileMetadata';

function useThreadInspection(threadId: string | undefined, updatedAt: string | undefined, enabled: boolean) {
  const [result, setResult] = useState<{ threadId: string; data?: ThreadInspection; error?: string } | null>(null);
  useEffect(() => {
    if (!threadId || !enabled) return;
    let active = true;
    const refresh = () => {
      void getThreadInspection(threadId).then((data) => {
        if (active) setResult({ threadId, data });
      }).catch((error: Error) => {
        if (active) setResult({ threadId, error: error.message });
      });
    };
    const onFilesChanged = (event: Event) => {
      if ((event as CustomEvent<{ threadId: string }>).detail.threadId === threadId) refresh();
    };
    refresh();
    window.addEventListener('runforge:files-changed', onFilesChanged);
    return () => {
      active = false;
      window.removeEventListener('runforge:files-changed', onFilesChanged);
    };
  }, [threadId, updatedAt, enabled]);
  return result?.threadId === threadId ? result : null;
}

export function ThreadStorageUsage({ thread }: { thread: Thread | null }) {
  const result = useThreadInspection(thread?.id, thread?.updated_at, Boolean(thread));
  if (!thread) return null;
  return <span className="shrink-0 text-xs text-muted-foreground" title={result?.data ? `工作目录逻辑大小；磁盘分配 ${formatFileSize(result.data.storage.allocatedBytes)}，${result.data.storage.fileCount} 个文件` : result?.error}>
    {result?.data ? `存储 ${formatFileSize(result.data.storage.logicalBytes)}` : result?.error ? '存储读取失败' : '正在读取存储…'}
  </span>;
}

export function ThreadHoverPreview({ thread, children }: { thread: Thread; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const result = useThreadInspection(thread.id, thread.updated_at, open);
  return (
    <HoverCard openDelay={0} closeDelay={0} open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] !animate-none space-y-3" aria-label="对话摘要">
        <div className="break-words text-sm font-medium">{thread.title?.trim() || thread.fallback_title?.trim() || '新会话'}</div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>创建：{formatFileDate(thread.created_at)}</div>
          <div>更新：{formatFileDate(thread.updated_at)}</div>
          <div>工作目录：{result?.data ? `${formatFileSize(result.data.storage.logicalBytes)} · ${result.data.storage.fileCount} 个文件` : result?.error ? '读取失败' : '正在读取…'}</div>
        </div>
        {result?.error ? <div className="text-xs text-destructive">{result.error}</div> : result?.data ? (
          <div className="space-y-2 border-t pt-2">
            <div className="text-xs text-muted-foreground">最早的用户消息</div>
            {result.data.userMessages.length ? <ol className="list-inside list-decimal space-y-2 text-xs">
              {result.data.userMessages.map((message, index) => <li key={`${message.createdAt}:${index}`} className="line-clamp-3 whitespace-pre-wrap break-words">{message.content}</li>)}
            </ol> : <div className="text-xs text-muted-foreground">暂无用户消息</div>}
          </div>
        ) : <div className="border-t pt-2 text-xs text-muted-foreground">正在读取用户消息…</div>}
      </HoverCardContent>
    </HoverCard>
  );
}
