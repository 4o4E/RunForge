import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { FileUp, Folder, FolderUp, Paperclip, RefreshCw, Terminal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { listRemoteFiles, type RemoteFileEntry } from '@/api';
import type { LlmModelOption } from '@/api';
import type { UsageSnapshot } from './Conversation';
import { ModelSearchSelect } from './ModelSearchSelect';
import { useNotifications } from './GlobalNotifications';

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
  modelOptions: LlmModelOption[];
  selectedModelRef: string;
  editingRunId: string | null;
  onDraftChange: (text: string) => void;
  onModelChange: (modelRef: string) => void;
  onSend: (text: string, modelRef: string) => void;
  onCancel: () => void;
  onCancelEdit: () => void;
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

function textareaOverflowsInline(textarea: HTMLTextAreaElement): boolean {
  return textarea.value.length > 0 && textarea.scrollWidth > textarea.clientWidth + 1;
}

function hasFileTransfer(data: DataTransfer | null): boolean {
  return Boolean(data?.types && Array.from(data.types).includes('Files'));
}

function filesFromTransfer(files: FileList | null | undefined): File[] {
  return files ? Array.from(files) : [];
}

function filesFromClipboard(data: DataTransfer | null): File[] {
  const files = filesFromTransfer(data?.files);
  if (files.length) return files;
  return Array.from(data?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function extensionFromType(type: string): string {
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/svg+xml') return '.svg';
  if (type === 'image/avif') return '.avif';
  return '';
}

function safeUploadName(name: string, fallback: string): string {
  const cleaned = name.trim().replace(/[\\/]+/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function autoUploadPath(file: File, index: number, source: 'paste' | 'drop'): string {
  const stamp = String(Date.now());
  const fallback = source === 'paste'
    ? `clipboard-${stamp}-${index + 1}${extensionFromType(file.type) || '.bin'}`
    : `file-${stamp}-${index + 1}${extensionFromType(file.type)}`;
  const name = safeUploadName(file.name, fallback);
  return `uploads/${stamp}-${index + 1}-${name}`;
}

function ContextUsageMeter({ usage }: { usage: UsageSnapshot | null }) {
  const used = usage?.estContextTokens;
  const budget = usage?.contextBudget;
  const ratio = used != null && budget && budget > 0 ? Math.min(1, Math.max(0, used / budget)) : 0;
  const percent = used != null && budget && budget > 0 ? Math.round(ratio * 100) : null;
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - ratio);
  const cacheRatio = usage?.cachedInputTokens != null && usage.inputTokens && usage.inputTokens > 0
    ? `${((usage.cachedInputTokens / usage.inputTokens) * 100).toFixed(1)}%`
    : '暂无';
  const title = [
    used != null
      ? `上下文：${used.toLocaleString()}${budget ? ` / ${budget.toLocaleString()}` : ''} token${percent != null ? `，占比 ${percent}%` : ''}`
      : '上下文：暂无数据',
    `输入 token：${usage?.inputTokens?.toLocaleString() ?? '暂无'}`,
    `输出 token：${usage?.outputTokens?.toLocaleString() ?? '暂无'}`,
    `缓存命中：${usage?.cachedInputTokens?.toLocaleString() ?? '暂无'}，占比 ${cacheRatio}`,
  ].join('\n');

  return (
    <div
      className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
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
          className={cn(percent != null && percent >= 85 ? 'text-destructive' : percent != null && percent >= 65 ? 'text-foreground' : 'text-muted-foreground')}
        />
      </svg>
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
  modelOptions,
  selectedModelRef,
  editingRunId,
  onDraftChange,
  onModelChange,
  onSend,
  onCancel,
  onCancelEdit,
  onRemoveAttachment,
  onOpenRemoteFiles,
  onUploadLocal,
}: Props) {
  const { notify } = useNotifications();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptFrameRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
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
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [quickUploading, setQuickUploading] = useState(false);
  const localDraftRef = useRef(draft);
  const [autoMultiline, setAutoMultiline] = useState(false);
  const multilineDraft = localDraft.includes('\n') || autoMultiline;

  useEffect(() => {
    if (draft === localDraftRef.current) return;
    localDraftRef.current = draft;
    setLocalDraft(draft);
    setAutoMultiline(false);
  }, [draft]);

  useLayoutEffect(() => {
    if (multilineDraft) return undefined;
    const textarea = promptFrameRef.current?.querySelector('textarea');
    if (!textarea) return undefined;
    const updateOverflow = () => {
      if (textareaOverflowsInline(textarea)) {
        setAutoMultiline(true);
      }
    };
    updateOverflow();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateOverflow) : null;
    observer?.observe(textarea);
    if (promptFrameRef.current) observer?.observe(promptFrameRef.current);
    window.addEventListener('resize', updateOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateOverflow);
    };
  }, [localDraft, multilineDraft, selectedModelRef, modelOptions.length]);

  function handleDraftChange(text: string, textarea: HTMLTextAreaElement) {
    const hasNewline = text.includes('\n');
    const nextAutoMultiline = !hasNewline && (autoMultiline ? text.length > 0 : textareaOverflowsInline(textarea));
    setAutoMultiline(nextAutoMultiline);
    localDraftRef.current = text;
    setLocalDraft(text);
    onDraftChange(text);
  }

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text?.trim() ?? '';
    if ((!text && !attachments.length) || disabled || waitingForAskUser) return;
    setAutoMultiline(false);
    localDraftRef.current = '';
    setLocalDraft('');
    onSend(text, selectedModelRef);
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

  async function uploadInlineFiles(files: File[], source: 'paste' | 'drop') {
    if (!files.length) return;
    if (disabled || waitingForAskUser) {
      notify({ variant: 'error', title: '现在不能添加附件', description: waitingForAskUser ? '请先回答上方问题。' : '当前对话正在运行。' });
      return;
    }

    setQuickUploading(true);
    try {
      for (let index = 0; index < files.length; index += 1) {
        await onUploadLocal(files[index], autoUploadPath(files[index], index, source));
      }
      notify({
        variant: 'success',
        title: source === 'paste' ? '已粘贴附件' : '已添加拖拽附件',
        description: `${files.length} 个文件已上传到 uploads/ 并加入本轮消息。`,
      });
    } catch (err) {
      notify({ variant: 'error', title: '附件上传失败', description: (err as Error).message });
    } finally {
      setQuickUploading(false);
    }
  }

  function handlePasteFiles(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromClipboard(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void uploadInlineFiles(files, 'paste');
  }

  function handleDragEnter(event: ReactDragEvent<HTMLFormElement>) {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLFormElement>) {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled || waitingForAskUser ? 'none' : 'copy';
    setDraggingFiles(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLFormElement>) {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: ReactDragEvent<HTMLFormElement>) {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    const files = filesFromTransfer(event.dataTransfer.files);
    void uploadInlineFiles(files, 'drop');
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

  const modelSelect = (
    <ModelSearchSelect
      value={selectedModelRef}
      options={modelOptions}
      onChange={onModelChange}
      placeholder="选择模型"
      disabled={disabled || waitingForAskUser}
      variant="ghost"
      className="h-8 w-auto min-w-0 px-2 text-xs text-muted-foreground hover:text-foreground"
    />
  );

  return (
    <div className="px-6 py-3">
      <div className="flex min-w-0">
        <div className="min-w-0 flex-1">
          <div ref={promptFrameRef} className={cn('mx-auto', wide ? 'max-w-5xl' : 'max-w-3xl')}>
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
            {editingRunId && !waitingQuestion && (
              <div className="mb-2 flex min-w-0 items-center gap-2 rounded-md border border-foreground/20 bg-muted px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">正在修改上一条消息</div>
                  <div className="mt-0.5 truncate text-muted-foreground">发送后会基于修改后的内容重新生成当前回复。</div>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" onClick={onCancelEdit} title="取消修改">
                  <X className="size-4" />
                </Button>
              </div>
            )}
            {waitingQuestion && (
              <div className="mb-2 rounded-md border border-foreground/30 bg-muted px-3 py-2 text-sm">
                <div className="font-medium">等待你的回答</div>
                <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{waitingQuestion}</div>
              </div>
            )}
            <PromptInput
              className={cn(
                'composer-input',
                !multilineDraft && 'composer-single-line',
                multilineDraft && 'composer-multiline',
                draggingFiles && 'ring-1 ring-primary/60',
              )}
              disableFileHandling
              onDragEnterCapture={handleDragEnter}
              onDragLeaveCapture={handleDragLeave}
              onDragOverCapture={handleDragOver}
              onDropCapture={handleDrop}
              onSubmit={handleSubmit}
            >
              {draggingFiles && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border border-primary/50 bg-background/85 text-sm font-medium text-foreground shadow-sm">
                  松开添加附件
                </div>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    title="添加附件"
                    className="composer-attachment-control size-8 shrink-0 text-muted-foreground hover:text-foreground"
                  >
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
              <PromptInputTextarea
                onChange={(event) => handleDraftChange(event.currentTarget.value, event.currentTarget)}
                onPaste={handlePasteFiles}
                disabled={disabled || waitingForAskUser}
                placeholder={waitingForAskUser ? '请在上方 ask_user 表单中回答' : '描述一个任务…（Enter 发送，Shift+Enter 换行）'}
                value={localDraft}
                wrap={multilineDraft ? 'soft' : 'off'}
                className={cn(
                  'min-w-0 px-2 py-1.5 leading-5',
                  multilineDraft
                    ? 'max-h-[14rem] min-h-16 basis-full overflow-y-auto'
                    : 'h-8 min-h-8 max-h-8 whitespace-pre overflow-x-auto overflow-y-hidden',
                )}
              />
              <div className="composer-actions ml-auto flex shrink-0 items-center gap-1">
                {modelSelect}
                <ContextUsageMeter usage={usage} />
                <PromptInputSubmit
                  size="icon-sm"
                  className="!size-8 !p-0 shrink-0"
                  status={disabled && !waitingForAskUser ? 'streaming' : undefined}
                  disabled={waitingForAskUser || (!disabled && !localDraft.trim() && !attachments.length)}
                  onStop={onCancel}
                />
              </div>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(event) => chooseLocal(event.currentTarget.files?.[0])}
              />
            </PromptInput>
            {quickUploading && (
              <div className="mt-2 text-xs text-muted-foreground">正在上传附件…</div>
            )}
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
