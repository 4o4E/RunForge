import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BundledLanguage } from 'shiki';
import { Check, Code2, Copy, Download, Eye, ChevronRight, FileText, Folder, FolderOpen, Link, PanelRightClose, PanelRightOpen, Paperclip, RefreshCw, X } from 'lucide-react';
import {
  createRemoteFileShareLink,
  listRemoteFiles,
  previewRemoteFile,
  previewRemoteFileHex,
  signedRemoteFileUrl,
  signedRemoteFileRawUrl,
  type FileShareAccess,
  type FileHexPreview,
  type FileHexRow,
  type FilePreview,
  type RemoteFileEntry,
} from '@/api';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { MarkdownContent } from '@/components/MarkdownContent';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface PreviewChunk {
  startLine: number;
  lines: string[];
}

interface PreviewRow {
  lineNumber: number;
  text: string;
}

type MediaKind = 'image' | 'video' | 'audio';

interface Props {
  open: boolean;
  width: number;
  previewPath: string | null;
  embedded?: boolean;
  compact?: boolean;
  shareAccess?: FileShareAccess;
  showAttach?: boolean;
  showShare?: boolean;
  showBrowser?: boolean;
  onClose: () => void;
  onAttach: (entry: { kind: 'remote'; path: string; name: string; size?: number }) => void;
  onOpenFile?: (path: string) => void;
}

const LANGUAGE_BY_EXT: Record<string, BundledLanguage> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  csv: 'csv',
  py: 'python',
  rs: 'rust',
  sh: 'shellscript',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  toml: 'toml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};
const INITIAL_PREVIEW_LINES = 80;
const MORE_PREVIEW_LINES = 240;
const INITIAL_HEX_BYTES = 4 * 1024;
const MORE_HEX_BYTES = 16 * 1024;
const RAW_URL_TTL_SECONDS = 24 * 60 * 60;
const SHARE_PRESETS = [
  { label: '1 天', seconds: 24 * 60 * 60 },
  { label: '3 天', seconds: 3 * 24 * 60 * 60 },
  { label: '7 天', seconds: 7 * 24 * 60 * 60 },
  { label: '1 个月', seconds: 30 * 24 * 60 * 60 },
  { label: '10 年', seconds: 10 * 365 * 24 * 60 * 60 },
];
const CUSTOM_UNITS = [
  { label: '分钟', value: 'minute', seconds: 60 },
  { label: '小时', value: 'hour', seconds: 60 * 60 },
  { label: '天', value: 'day', seconds: 24 * 60 * 60 },
  { label: '月', value: 'month', seconds: 30 * 24 * 60 * 60 },
  { label: '年', value: 'year', seconds: 365 * 24 * 60 * 60 },
] as const;
const MIN_SHARE_TTL_SECONDS = 60;
const MAX_SHARE_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'weba']);
const BINARY_EXTENSIONS = new Set([
  'pdf',
  'zip',
  'gz',
  'tgz',
  'tar',
  '7z',
  'rar',
  'wasm',
  'sqlite',
  'sqlite3',
  'db',
  'bin',
  'exe',
  'dll',
  'so',
  'dylib',
]);

function fileName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatSize(size?: number): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function extOf(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function languageForPath(path: string): BundledLanguage {
  return LANGUAGE_BY_EXT[extOf(path)] ?? 'log';
}

function mediaKindForPath(path: string): MediaKind | null {
  const ext = extOf(path);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

function shouldUseHexSource(path: string): boolean {
  const ext = extOf(path);
  return mediaKindForPath(path) != null || BINARY_EXTENSIONS.has(ext);
}

function formatHexOffset(offset: number): string {
  return offset.toString(16).toUpperCase().padStart(8, '0');
}

function clampShareTtl(seconds: number): number {
  return Math.min(MAX_SHARE_TTL_SECONDS, Math.max(MIN_SHARE_TTL_SECONDS, Math.floor(seconds)));
}

function formatExpiresAt(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fileTone(path: string): string {
  const ext = extOf(path);
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp'].includes(ext)) return 'text-foreground';
  if (['json', 'yaml', 'yml', 'toml', 'css', 'html', 'md'].includes(ext)) return 'text-muted-foreground';
  return 'text-muted-foreground';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function withDownloadParam(url: string): string {
  const next = new URL(url, window.location.origin);
  next.searchParams.set('download', '1');
  return `${next.pathname}${next.search}`;
}

function startTreeResize(event: ReactPointerEvent, width: number, onChange: (width: number) => void, direction: 1 | -1 = 1) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = width;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMove = (moveEvent: PointerEvent) => {
    onChange(clamp(startWidth + (moveEvent.clientX - startX) * direction, 220, 420));
  };
  const onUp = () => {
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}

export function RemoteFilesPanel({
  open,
  width,
  previewPath,
  embedded = false,
  compact = false,
  shareAccess,
  showAttach = true,
  showShare = true,
  showBrowser = true,
  onClose,
  onAttach,
  onOpenFile,
}: Props) {
  const [currentPath, setCurrentPath] = useState('.');
  const [treeWidth, setTreeWidth] = useState(270);
  const [showTree, setShowTree] = useState(() => !compact || !previewPath);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['.']));
  const [treeEntries, setTreeEntries] = useState<Record<string, RemoteFileEntry[]>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<number | undefined>();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [chunks, setChunks] = useState<PreviewChunk[]>([]);
  const [hexPreview, setHexPreview] = useState<FileHexPreview | null>(null);
  const [hexRows, setHexRows] = useState<FileHexRow[]>([]);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>('source');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rawUrl, setRawUrl] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [customShareValue, setCustomShareValue] = useState('1');
  const [customShareUnit, setCustomShareUnit] = useState<typeof CUSTOM_UNITS[number]['value']>('day');
  const previewRequestRef = useRef(0);
  const pendingPreviewStartsRef = useRef<Set<number>>(new Set());
  const pendingHexOffsetsRef = useRef<Set<number>>(new Set());

  async function loadDir(path = currentPath, select = true) {
    setLoading(true);
    setError(null);
    try {
      const data = await listRemoteFiles(path);
      if (select) setCurrentPath(data.path);
      setTreeEntries((current) => ({ ...current, [data.path]: data.entries }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function openFile(path: string, size?: number, startLine = 1) {
    if (startLine > 1 && pendingPreviewStartsRef.current.has(startLine)) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    const mediaKind = mediaKindForPath(path);
    const hexSource = shouldUseHexSource(path);
    if (startLine === 1) {
      if (compact) setShowTree(false);
      pendingPreviewStartsRef.current.clear();
      pendingHexOffsetsRef.current.clear();
      setSelectedPath(path);
      setSelectedSize(size);
      setPreview(null);
      setChunks([]);
      setHexPreview(null);
      setHexRows([]);
      setRawUrl('');
      setDownloadUrl('');
      setShareOpen(false);
      setShareExpiresAt(null);
      setShareCopied(false);
      setPreviewMode(mediaKind || ['html', 'htm', 'md'].includes(extOf(path)) ? 'preview' : 'source');
    } else {
      pendingPreviewStartsRef.current.add(startLine);
    }
    setLoading(true);
    setError(null);
    try {
      if (hexSource) {
        const data = await previewRemoteFileHex(path, 0, INITIAL_HEX_BYTES, { share: shareAccess });
        if (previewRequestRef.current !== requestId) return;
        setSelectedPath(data.path);
        setSelectedSize(size ?? data.size);
        setHexPreview(data);
        setHexRows(data.rows);
        return;
      }

      const limit = startLine === 1 ? INITIAL_PREVIEW_LINES : MORE_PREVIEW_LINES;
      const renderable = ['html', 'htm', 'md'].includes(extOf(path));
      const data = await previewRemoteFile(path, startLine, limit, { render: startLine === 1 && renderable, share: shareAccess });
      if (previewRequestRef.current !== requestId) return;
      setSelectedPath(data.path);
      setSelectedSize(size ?? data.size);
      setPreview(data);
      const nextChunk = { startLine: data.startLine, lines: data.lines };
      setChunks((current) => startLine === 1 ? [nextChunk] : [...current, nextChunk]);
    } catch (err) {
      if (previewRequestRef.current !== requestId) return;
      setError((err as Error).message);
    } finally {
      pendingPreviewStartsRef.current.delete(startLine);
      if (previewRequestRef.current === requestId) setLoading(false);
    }
  }

  async function loadMoreHex() {
    if (!selectedPath || !hexPreview?.nextOffset || loading || pendingHexOffsetsRef.current.has(hexPreview.nextOffset)) return;
    const requestId = previewRequestRef.current;
    const offset = hexPreview.nextOffset;
    pendingHexOffsetsRef.current.add(offset);
    setLoading(true);
    setError(null);
    try {
      const data = await previewRemoteFileHex(selectedPath, offset, MORE_HEX_BYTES, { share: shareAccess });
      if (previewRequestRef.current !== requestId) return;
      setSelectedSize(data.size);
      setHexPreview(data);
      setHexRows((current) => [...current, ...data.rows]);
    } catch (err) {
      if (previewRequestRef.current !== requestId) return;
      setError((err as Error).message);
    } finally {
      pendingHexOffsetsRef.current.delete(offset);
      if (previewRequestRef.current === requestId) setLoading(false);
    }
  }

  async function toggleDir(path: string) {
    const willOpen = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (willOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    setCurrentPath(path);
    if (willOpen && !treeEntries[path]) await loadDir(path, false);
  }

  function selectFile(entry: RemoteFileEntry) {
    if (onOpenFile) {
      onOpenFile(entry.path);
      return;
    }
    void openFile(entry.path, entry.size);
  }

  useEffect(() => {
    if (open && showBrowser) void loadDir(currentPath);
    // 打开面板时刷新当前目录，保留用户所在位置。
  }, [open, showBrowser]);

  useEffect(() => {
    if (open && previewPath) void openFile(previewPath);
  }, [open, previewPath]);

  useEffect(() => {
    if (!compact) return;
    setShowTree(!previewPath);
  }, [compact, previewPath]);

  const previewLanguage = selectedPath ? languageForPath(selectedPath) : 'log';
  const selectedExt = selectedPath ? extOf(selectedPath) : '';
  const selectedMediaKind = selectedPath ? mediaKindForPath(selectedPath) : null;
  const selectedUsesHexSource = selectedPath ? shouldUseHexSource(selectedPath) : false;
  const selectedIsHtml = ['html', 'htm'].includes(selectedExt);
  const selectedIsMarkdown = selectedExt === 'md';
  const selectedCanRender = selectedIsHtml || selectedIsMarkdown || selectedMediaKind != null;
  const previewRows = useMemo<PreviewRow[]>(() => {
    const byLine = new Map<number, string>();
    const sortedChunks = [...chunks].sort((a, b) => a.startLine - b.startLine);
    for (const chunk of sortedChunks) {
      chunk.lines.forEach((text, index) => {
        const lineNumber = chunk.startLine + index;
        if (!byLine.has(lineNumber)) byLine.set(lineNumber, text);
      });
    }

    const firstLine = sortedChunks[0]?.startLine ?? 1;
    const rows: PreviewRow[] = [];
    for (let lineNumber = firstLine; byLine.has(lineNumber); lineNumber += 1) {
      rows.push({ lineNumber, text: byLine.get(lineNumber) ?? '' });
    }
    return rows;
  }, [chunks]);
  const previewCode = useMemo(() => previewRows.map((row) => row.text).join('\n'), [previewRows]);
  const previewStartLine = previewRows[0]?.lineNumber ?? 1;
  const loadedLines = previewRows.length;
  const totalLines = preview?.totalLines ?? null;

  useEffect(() => {
    let canceled = false;
    setRawUrl('');
    if (!selectedPath || !selectedMediaKind) return () => {
      canceled = true;
    };
    const rawUrlPromise = shareAccess
      ? Promise.resolve(signedRemoteFileUrl(selectedPath, shareAccess))
      : signedRemoteFileRawUrl(selectedPath, RAW_URL_TTL_SECONDS);
    rawUrlPromise
      .then((url) => {
        if (!canceled) setRawUrl(url);
      })
      .catch((err) => {
        if (!canceled) setError((err as Error).message);
      });
    return () => {
      canceled = true;
    };
  }, [selectedMediaKind, selectedPath, shareAccess]);

  useEffect(() => {
    let canceled = false;
    setDownloadUrl('');
    if (!selectedPath) return () => {
      canceled = true;
    };
    const rawUrlPromise = shareAccess
      ? Promise.resolve(signedRemoteFileUrl(selectedPath, shareAccess))
      : signedRemoteFileRawUrl(selectedPath, RAW_URL_TTL_SECONDS);
    rawUrlPromise
      .then((url) => {
        if (!canceled) setDownloadUrl(withDownloadParam(url));
      })
      .catch((err) => {
        if (!canceled) setError((err as Error).message);
      });
    return () => {
      canceled = true;
    };
  }, [selectedPath, shareAccess]);

  async function copyShareLink(ttlSeconds: number) {
    if (!selectedPath || shareBusy) return;
    setShareBusy(true);
    setError(null);
    setShareCopied(false);
    try {
      const link = await createRemoteFileShareLink(selectedPath, clampShareTtl(ttlSeconds));
      const absoluteUrl = new URL(link.url, window.location.origin).toString();
      await navigator.clipboard?.writeText(absoluteUrl);
      setShareExpiresAt(link.expiresAt);
      setShareCopied(true);
      setShareOpen(false);
      window.setTimeout(() => setShareCopied(false), 1600);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setShareBusy(false);
    }
  }

  const customUnit = CUSTOM_UNITS.find((unit) => unit.value === customShareUnit) ?? CUSTOM_UNITS[2];
  const customShareSeconds = clampShareTtl((Number(customShareValue) || 0) * customUnit.seconds);

  if (!open) return null;
  const hasUnloadedLines = preview?.mode === 'chunk' && (totalLines == null || loadedLines < totalLines);
  const nextLine = hasUnloadedLines ? previewStartLine + loadedLines : null;
  const loadMorePreview = () => {
    if (!selectedPath || nextLine == null || loading || !hasUnloadedLines) return;
    void openFile(selectedPath, selectedSize, nextLine);
  };
  const hasMoreHex = selectedUsesHexSource && Boolean(hexPreview?.hasMore && hexPreview.nextOffset != null);
  const showPanelHeader = showBrowser || !embedded;

  const renderRows = (entries: RemoteFileEntry[] | undefined, depth: number): JSX.Element[] =>
    (entries ?? []).flatMap((entry) => {
      const isDir = entry.type === 'dir';
      const isOpen = expanded.has(entry.path);
      const selected = entry.path === selectedPath || entry.path === currentPath;
      const row = (
        <button
          key={entry.path}
          className={cn(
            'group/file flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-[13px] hover:bg-accent/70',
            selected && 'bg-accent text-accent-foreground',
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => isDir ? void toggleDir(entry.path) : selectFile(entry)}
          title={entry.path}
        >
          {isDir ? (
            <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          {isDir ? (
            isOpen ? <FolderOpen className="size-4 shrink-0 text-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileText className={cn('size-4 shrink-0', fileTone(entry.path))} />
          )}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {!isDir && <span className="hidden shrink-0 text-[11px] text-muted-foreground group-hover/file:inline">{formatSize(entry.size)}</span>}
        </button>
      );
      if (!isDir || !isOpen) return [row];
      return [row, ...renderRows(treeEntries[entry.path], depth + 1)];
    });
  const renderTreeBrowser = (side: boolean) => (
    <div
      className={cn(
        'flex min-h-0 flex-col bg-muted/20',
        side ? 'shrink-0 border-l' : 'h-full rounded-md border',
      )}
      style={side ? { width: treeWidth } : undefined}
    >
      <div className="flex h-9 shrink-0 items-center border-b px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Explorer</span>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
        <button
          className={cn(
            'flex h-7 w-full items-center gap-1.5 px-2 text-left text-[13px] hover:bg-accent/70',
            currentPath === '.' && 'bg-accent text-accent-foreground',
          )}
          onClick={() => void toggleDir('.')}
          title="workspace"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded.has('.') && 'rotate-90')} />
          {expanded.has('.') ? <FolderOpen className="size-4 shrink-0 text-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">workspace</span>
        </button>
        {expanded.has('.') && renderRows(treeEntries['.'], 1)}
      </div>
    </div>
  );

  return (
    <aside className={cn('flex h-full shrink-0 flex-col bg-card', !embedded && 'border-l')} style={embedded ? undefined : { width }}>
      {showPanelHeader && (
        <div className="flex h-14 items-center gap-2 border-b px-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">远程文件</div>
            <div className="truncate text-xs text-muted-foreground" title={selectedPath ?? currentPath}>
              {selectedPath ?? currentPath}
            </div>
          </div>
          {showBrowser && (
            <>
              <Button variant="ghost" size="icon" onClick={() => void loadDir(currentPath)} title="刷新">
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              </Button>
              <Button
                variant={showTree ? 'secondary' : 'ghost'}
                size="icon"
                onClick={() => setShowTree((value) => !value)}
                title={compact ? (showTree ? '显示文件预览' : '浏览文件树') : (showTree ? '隐藏文件树' : '显示文件树')}
              >
                {showTree ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
              </Button>
            </>
          )}
          {!embedded && (
            <Button variant="ghost" size="icon" onClick={onClose} title="关闭">
              <X className="size-4" />
            </Button>
          )}
        </div>
      )}

      {error && <div className="border-b px-3 py-2 text-xs text-destructive">{error}</div>}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden p-3">
          {compact && showTree ? (
            renderTreeBrowser(false)
          ) : selectedPath ? (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="flex shrink-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{selectedPath}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatSize(selectedSize)}{!selectedUsesHexSource && totalLines != null ? ` · ${totalLines} 行` : ''}
                  </div>
                </div>
                {selectedCanRender && (
                  <div className="flex rounded-md border bg-background p-0.5">
                    <Button
                      variant={previewMode === 'preview' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => setPreviewMode('preview')}
                      title={selectedMediaKind ? '预览媒体' : selectedIsHtml ? '渲染 HTML' : '渲染 Markdown'}
                    >
                      <Eye className="size-4" />
                    </Button>
                    <Button
                      variant={previewMode === 'source' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => setPreviewMode('source')}
                      title="查看源码"
                    >
                      <Code2 className="size-4" />
                    </Button>
                  </div>
                )}
                {showAttach && (
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    onClick={() => onAttach({ kind: 'remote', path: selectedPath, name: fileName(selectedPath), size: selectedSize })}
                    title="添加到输入框"
                    aria-label="添加到输入框"
                  >
                    <Paperclip className="size-4" />
                  </Button>
                )}
                {downloadUrl && (
                  <Button asChild variant="ghost" size="icon-sm" title="下载文件" aria-label="下载文件">
                    <a href={downloadUrl}>
                      <Download className="size-4" />
                    </a>
                  </Button>
                )}
                {showShare && (
                  <Popover open={shareOpen} onOpenChange={setShareOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={shareBusy}
                        title="分享文件"
                        aria-label="分享文件"
                      >
                        <Link className="size-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72 p-3">
                      <div className="grid gap-3">
                        <div>
                          <div className="text-sm font-medium">选择分享有效期</div>
                          <div className="mt-1 truncate text-xs text-muted-foreground" title={selectedPath}>
                            {selectedPath}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {SHARE_PRESETS.map((preset) => (
                            <Button
                              key={preset.seconds}
                              variant="outline"
                              size="sm"
                              onClick={() => void copyShareLink(preset.seconds)}
                              disabled={shareBusy}
                              title={`复制 ${preset.label} 有效的分享链接`}
                            >
                              {preset.label}
                            </Button>
                          ))}
                        </div>
                        <div className="grid gap-2 border-t pt-3">
                          <div className="text-xs font-medium text-muted-foreground">自定义有效期</div>
                          <div className="flex items-center gap-1">
                            <Input
                              className="h-8 w-16"
                              min={1}
                              type="number"
                              value={customShareValue}
                              onChange={(event) => setCustomShareValue(event.target.value)}
                              title="自定义有效期数值"
                            />
                            <Select value={customShareUnit} onValueChange={(value) => setCustomShareUnit(value as typeof customShareUnit)}>
                              <SelectTrigger className="h-8 flex-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CUSTOM_UNITS.map((unit) => (
                                  <SelectItem key={unit.value} value={unit.value}>{unit.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button variant="secondary" size="icon-sm" onClick={() => void copyShareLink(customShareSeconds)} disabled={shareBusy} title="复制分享链接" aria-label="复制分享链接">
                              <Copy className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
              {(shareCopied || shareExpiresAt) && (
                <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {shareCopied ? (
                    <>
                      <Check className="size-3.5 text-emerald-600" />
                      <span className="text-emerald-600">分享链接已复制，到期 {formatExpiresAt(shareExpiresAt)}</span>
                    </>
                  ) : (
                    <span>上次分享链接到期 {formatExpiresAt(shareExpiresAt)}</span>
                  )}
                </div>
              )}
              <div className="min-h-0 flex-1">
                {selectedMediaKind === 'image' && previewMode === 'preview' ? (
                  <div className="flex h-full items-center justify-center overflow-auto rounded-md border bg-muted/20 p-3">
                    {rawUrl ? <img src={rawUrl} alt={fileName(selectedPath)} className="max-h-full max-w-full object-contain" /> : <span className="text-sm text-muted-foreground">正在生成预览链接…</span>}
                  </div>
                ) : selectedMediaKind === 'video' && previewMode === 'preview' ? (
                  <div className="flex h-full items-center justify-center overflow-auto rounded-md border bg-black p-3">
                    {rawUrl ? <video src={rawUrl} className="max-h-full max-w-full" controls /> : <span className="text-sm text-muted-foreground">正在生成预览链接…</span>}
                  </div>
                ) : selectedMediaKind === 'audio' && previewMode === 'preview' ? (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 px-4">
                    {rawUrl ? <audio src={rawUrl} className="w-full max-w-xl" controls /> : <span className="text-sm text-muted-foreground">正在生成预览链接…</span>}
                  </div>
                ) : selectedUsesHexSource && previewMode === 'source' && hexRows.length > 0 ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-background">
                    <div className="grid grid-cols-[6rem_minmax(24rem,1fr)_8rem] border-b bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      <span>Offset</span>
                      <span>Hex</span>
                      <span>ASCII</span>
                    </div>
                    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
                      {hexRows.map((row) => (
                        <div
                          key={`${row.offset}-${row.hex}`}
                          className="grid grid-cols-[6rem_minmax(24rem,1fr)_8rem] gap-3 border-b border-border/40 px-3 py-1 font-mono text-[12px] leading-5"
                        >
                          <span className="text-muted-foreground">{formatHexOffset(row.offset)}</span>
                          <span className="whitespace-pre text-foreground">{row.hex}</span>
                          <span className="whitespace-pre text-muted-foreground">{row.ascii}</span>
                        </div>
                      ))}
                      {hasMoreHex && (
                        <div className="flex justify-center p-3">
                          <Button variant="outline" size="sm" onClick={() => void loadMoreHex()} disabled={loading}>
                            {loading ? '正在加载…' : '加载更多'}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : selectedUsesHexSource && previewMode === 'source' && hexPreview ? (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
                    暂无 Hex 内容
                  </div>
                ) : selectedUsesHexSource && previewMode === 'source' ? (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
                    正在加载 Hex 源码…
                  </div>
                ) : loading && chunks.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
                    正在加载前 {INITIAL_PREVIEW_LINES} 行…
                  </div>
                ) : chunks.length > 0 && selectedIsHtml && previewMode === 'preview' ? (
                  <iframe
                    title={selectedPath}
                    className="h-full w-full rounded-md border bg-white"
                    sandbox="allow-scripts allow-forms allow-popups allow-downloads"
                    referrerPolicy="no-referrer"
                    srcDoc={previewCode}
                  />
                ) : chunks.length > 0 && selectedIsMarkdown && previewMode === 'preview' ? (
                  <div className="h-full overflow-auto rounded-md border bg-background px-5 py-4">
                    <MarkdownContent text={previewCode} />
                  </div>
                ) : chunks.length > 0 ? (
                  <CodeBlock
                    className="h-full"
                    code={previewCode}
                    fillHeight
                    language={previewLanguage}
                    loadingMore={loading && chunks.length > 0}
                    onReachEnd={nextLine != null ? loadMorePreview : undefined}
                    showLineNumbers
                    startLineNumber={previewStartLine}
                    showGlance
                    showRenderToggle={false}
                    showWrapToggle
                    maxHighlightChars={80_000}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground">
                    暂无预览内容
                  </div>
                )}
              </div>
              {preview?.mode === 'chunk' && (
                <div className="shrink-0 text-xs text-muted-foreground">
                  已加载 {loadedLines}{totalLines != null ? ` / ${totalLines}` : ''} 行{nextLine != null ? '，滚动到底部继续加载' : ''}
                </div>
              )}
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-muted-foreground">选择一个文件查看预览</div>
          )}
        </div>
        {showBrowser && showTree && !compact && (
          <>
            <div
              role="separator"
              aria-label="调整文件树宽度"
              className="h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-foreground/60"
              onPointerDown={(event) => startTreeResize(event, treeWidth, setTreeWidth, -1)}
            />
            {renderTreeBrowser(true)}
          </>
        )}
      </div>
    </aside>
  );
}
