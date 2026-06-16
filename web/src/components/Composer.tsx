import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { FileUp, Folder, FolderUp, Maximize2, Minimize2, Paperclip, RefreshCw, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { listRemoteFiles, type RemoteFileEntry } from '@/api';
import type { UsageSnapshot } from './Conversation';

export interface ComposerAttachment {
  kind: 'remote' | 'local' | 'shell';
  path: string;
  name: string;
  size?: number;
  text?: string;
}

interface Props {
  disabled: boolean;
  waitingQuestion: string | null;
  draft: string;
  wide: boolean;
  attachments: ComposerAttachment[];
  usage: UsageSnapshot | null;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onToggleWide: () => void;
  onRemoveAttachment: (path: string) => void;
  onOpenRemoteFiles: () => void;
  onUploadLocal: (file: File, path: string) => Promise<void>;
}

function formatSize(size?: number): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatCompactNumber(value?: number): string {
  if (value == null) return '--';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function ContextUsageMeter({ usage }: { usage: UsageSnapshot | null }) {
  const used = usage?.estContextTokens;
  const budget = usage?.contextBudget;
  const ratio = used != null && budget && budget > 0 ? Math.min(1, Math.max(0, used / budget)) : 0;
  const percent = used != null && budget && budget > 0 ? Math.round(ratio * 100) : null;
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - ratio);
  const title = used != null
    ? `上下文占用：${used.toLocaleString()}${budget ? ` / ${budget.toLocaleString()} token` : ' token'}${percent != null ? `，${percent}%` : ''}`
    : '上下文占用暂无数据';

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2 text-xs text-muted-foreground"
      title={title}
      aria-label={title}
    >
      <svg className="size-6 -rotate-90" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.18" />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={cn(percent != null && percent >= 85 ? 'text-destructive' : percent != null && percent >= 65 ? 'text-amber-600 dark:text-amber-400' : 'text-primary')}
        />
      </svg>
      <span className="tabular-nums">{percent != null ? `${percent}%` : used != null ? formatCompactNumber(used) : '0%'}</span>
    </div>
  );
}

export function Composer({
  disabled,
  waitingQuestion,
  draft,
  wide,
  attachments,
  usage,
  onDraftChange,
  onSend,
  onCancel,
  onToggleWide,
  onRemoveAttachment,
  onOpenRemoteFiles,
  onUploadLocal,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const waitingForAskUser = !!waitingQuestion;
  const [localDraft, setLocalDraft] = useState(draft);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [uploadDir, setUploadDir] = useState('uploads');
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dirEntries, setDirEntries] = useState<RemoteFileEntry[]>([]);
  const [dirParent, setDirParent] = useState<string | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  useEffect(() => {
    setLocalDraft(draft);
  }, [draft]);

  function handleDraftChange(text: string) {
    setLocalDraft(text);
    onDraftChange(text);
  }

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text?.trim();
    if (!text || disabled || waitingForAskUser) return;
    setLocalDraft('');
    onSend(text);
  }

  function chooseLocal(file: File | null | undefined) {
    if (!file) return;
    setLocalFile(file);
    setUploadName(file.name);
    setUploadDir('uploads');
  }

  async function confirmUpload() {
    if (!localFile || !uploadName.trim()) return;
    const path = `${uploadDir.trim() || '.'}/${uploadName.trim()}`.replace(/\/+/g, '/');
    setUploading(true);
    try {
      await onUploadLocal(localFile, path);
      setLocalFile(null);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function loadUploadDirs(path = uploadDir || '.') {
    setDirLoading(true);
    setDirError(null);
    try {
      const data = await listRemoteFiles(path || '.');
      setUploadDir(data.path === '.' ? '' : data.path);
      setDirParent(data.parent);
      setDirEntries(data.entries.filter((entry) => entry.type === 'dir'));
    } catch (err) {
      setDirError((err as Error).message);
      setDirEntries([]);
      setDirParent(null);
    } finally {
      setDirLoading(false);
    }
  }

  useEffect(() => {
    if (localFile) void loadUploadDirs(uploadDir || '.');
  }, [localFile]);

  return (
    <div className="bg-card px-6 py-4">
      <div className="flex min-w-0">
        <div className="min-w-0 flex-1">
          <div className={cn('mx-auto', wide ? 'max-w-5xl' : 'max-w-3xl')}>
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((att) => (
                  <button
                    key={`${att.kind}:${att.path}`}
                    type="button"
                    onClick={() => onRemoveAttachment(att.path)}
                    className="rounded-md border bg-background px-2 py-1 text-left text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
                    title="点击移除附件"
                  >
                    {att.kind === 'shell' && <Terminal className="mr-1 inline size-3" />}
                    {att.kind === 'local' ? '本地' : att.kind === 'remote' ? '远程' : 'Shell'} · {att.name}
                    {att.size != null ? ` · ${formatSize(att.size)}` : ''}
                  </button>
                ))}
              </div>
            )}
            {waitingQuestion && (
              <div className="mb-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                <div className="font-medium">等待你的回答</div>
                <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{waitingQuestion}</div>
              </div>
            )}
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <PromptInputTextarea
                  onChange={(event) => handleDraftChange(event.currentTarget.value)}
                  disabled={disabled || waitingForAskUser}
                  placeholder={waitingForAskUser ? '请在上方 ask_user 表单中回答' : '描述一个任务…（Enter 发送，Shift+Enter 换行）'}
                  value={localDraft}
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" disabled={disabled} title="添加附件">
                        <Paperclip className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={onOpenRemoteFiles}>
                        <Paperclip className="size-4" />
                        选择远程文件
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                        <FileUp className="size-4" />
                        上传本地文件
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(event) => chooseLocal(event.currentTarget.files?.[0])}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={onToggleWide} className="text-muted-foreground">
                    {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                    {wide ? '正常宽度' : '加宽对话'}
                  </Button>
                </PromptInputTools>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <ContextUsageMeter usage={usage} />
                  <PromptInputSubmit
                    status={disabled && !waitingForAskUser ? 'streaming' : undefined}
                    disabled={waitingForAskUser || (!disabled && !localDraft.trim())}
                    onStop={onCancel}
                  />
                </div>
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
        <div className="hidden w-7 shrink-0 xl:block" />
      </div>
      <Dialog open={!!localFile} onOpenChange={(open) => !open && setLocalFile(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上传本地文件</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              {localFile?.name} {localFile ? `· ${formatSize(localFile.size)}` : ''}
            </div>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">上传位置</span>
              <Input value={uploadDir} onChange={(event) => setUploadDir(event.currentTarget.value)} placeholder="uploads" />
            </label>
            <div className="rounded-md border bg-muted/20">
              <div className="flex items-center gap-2 border-b px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {uploadDir || '.'}
                </span>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => void loadUploadDirs(uploadDir || '.')} title="刷新目录">
                  <RefreshCw className={cn('size-3.5', dirLoading && 'animate-spin')} />
                </Button>
              </div>
              <div className="max-h-40 overflow-y-auto p-1">
                {dirParent && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => void loadUploadDirs(dirParent)}
                  >
                    <FolderUp className="size-3.5 text-muted-foreground" />
                    上级目录
                  </button>
                )}
                {dirEntries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => void loadUploadDirs(entry.path)}
                    title={entry.path}
                  >
                    <Folder className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </button>
                ))}
                {!dirEntries.length && !dirParent && (
                  <div className="px-2 py-3 text-xs text-muted-foreground">没有可选子目录</div>
                )}
              </div>
              {dirError && <div className="border-t px-2 py-1.5 text-xs text-destructive">{dirError}</div>}
            </div>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">文件名</span>
              <Input value={uploadName} onChange={(event) => setUploadName(event.currentTarget.value)} placeholder="example.txt" />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setLocalFile(null)}>取消</Button>
            <Button type="button" onClick={() => void confirmUpload()} disabled={uploading || !uploadName.trim()}>
              {uploading ? '上传中' : '确认上传'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
