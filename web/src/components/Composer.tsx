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
import { FileUp, Folder, FolderUp, Paperclip, RefreshCw, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  onDraftChange: (text: string) => void;
  onModelChange: (modelRef: string) => void;
  onSend: (text: string, modelRef: string) => void;
  onCancel: () => void;
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
  onDraftChange,
  onModelChange,
  onSend,
  onCancel,
  onRemoveAttachment,
  onOpenRemoteFiles,
  onUploadLocal,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptFrameRef = useRef<HTMLDivElement>(null);
  const restorePromptFocusRef = useRef(false);
  const previousMultilineRef = useRef(false);
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
  const localDraftRef = useRef(draft);
  const [autoMultiline, setAutoMultiline] = useState(false);
  const multilineDraft = localDraft.includes('\n') || autoMultiline;

  useLayoutEffect(() => {
    const previousMultiline = previousMultilineRef.current;
    previousMultilineRef.current = multilineDraft;
    if (!restorePromptFocusRef.current || previousMultiline === multilineDraft) return;
    restorePromptFocusRef.current = false;
    const textarea = promptFrameRef.current?.querySelector('textarea');
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    const cursor = textarea.value.length;
    textarea.setSelectionRange(cursor, cursor);
  }, [multilineDraft]);

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
        restorePromptFocusRef.current = promptFrameRef.current?.contains(document.activeElement) ?? false;
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
    const nextMultiline = hasNewline || nextAutoMultiline;
    if (nextMultiline !== multilineDraft && promptFrameRef.current?.contains(document.activeElement)) {
      restorePromptFocusRef.current = true;
    }
    setAutoMultiline(nextAutoMultiline);
    localDraftRef.current = text;
    setLocalDraft(text);
    onDraftChange(text);
  }

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text?.trim() ?? '';
    if ((!text && !attachments.length) || disabled || waitingForAskUser) return;
    if (multilineDraft && promptFrameRef.current?.contains(document.activeElement)) {
      restorePromptFocusRef.current = true;
    }
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
            {waitingQuestion && (
              <div className="mb-2 rounded-md border border-foreground/30 bg-muted px-3 py-2 text-sm">
                <div className="font-medium">等待你的回答</div>
                <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{waitingQuestion}</div>
              </div>
            )}
            <PromptInput className={cn('composer-input', !multilineDraft && 'composer-single-line')} onSubmit={handleSubmit}>
              {multilineDraft ? (
                <>
                  <PromptInputBody>
                    <PromptInputTextarea
                      onChange={(event) => handleDraftChange(event.currentTarget.value, event.currentTarget)}
                      disabled={disabled || waitingForAskUser}
                      placeholder={waitingForAskUser ? '请在上方 ask_user 表单中回答' : '描述一个任务…（Enter 发送，Shift+Enter 换行）'}
                      value={localDraft}
                      className="max-h-[14rem] min-h-16 overflow-y-auto"
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled}
                            title="添加附件"
                            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
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
                    </PromptInputTools>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
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
                  </PromptInputFooter>
                </>
              ) : (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled}
                        title="添加附件"
                        className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
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
                    disabled={disabled || waitingForAskUser}
                    placeholder={waitingForAskUser ? '请在上方 ask_user 表单中回答' : '描述一个任务…（Enter 发送，Shift+Enter 换行）'}
                    value={localDraft}
                    wrap="off"
                    className="h-8 min-h-8 max-h-8 min-w-0 whitespace-pre overflow-x-auto overflow-y-hidden px-2 py-1.5 leading-5"
                  />
                  <div className="ml-auto flex shrink-0 items-center gap-1">
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
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(event) => chooseLocal(event.currentTarget.files?.[0])}
              />
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
