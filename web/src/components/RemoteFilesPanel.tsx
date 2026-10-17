import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BundledLanguage } from 'shiki';
import { Code2, Copy, Download, Eye, ChevronRight, FileText, Folder, FolderOpen, FolderTree, Link, LocateFixed, PanelRightClose, PanelRightOpen, Paperclip, Pencil, RefreshCw, RotateCcw, Save, X } from 'lucide-react';
import {
  createRemoteFileShareLink,
  getRemoteFileContent,
  listRemoteFiles,
  previewRemoteFile,
  previewRemoteFileHex,
  saveRemoteFileContent,
  signedRemoteFileUrl,
  signedRemoteFileRawUrl,
  type FileShareAccess,
  type FileHexPreview,
  type FileHexRow,
  type FilePreview,
  type FileTextVersion,
  type RemoteFileEntry,
} from '@/api';
import { useNotifications } from '@/components/GlobalNotifications';
import { MarkdownContent } from '@/components/MarkdownContent';
import { OfficePreview, officePreviewKindForPath } from '@/components/OfficePreview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useWorkspaceFileContext } from '@/components/WorkspaceFileContext';
import { formatFileDate, formatFileSize } from '@/lib/fileMetadata';
import { DelimitedTextPreview } from '@/components/DelimitedTextPreview';

const MonacoTextEditor = lazy(() => import('@/components/MonacoTextEditor').then((module) => ({ default: module.MonacoTextEditor })));

class MonacoErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center px-3 text-center text-sm text-destructive">
          Monaco 编辑器加载失败：{this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

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
  readOnly?: boolean;
  shareAccess?: FileShareAccess;
  showAttach?: boolean;
  showShare?: boolean;
  showBrowser?: boolean;
  fileScope?: 'thread' | 'user';
  onClose: () => void;
  onAttach: (entry: { kind: 'remote'; path: string; name: string; size?: number }) => void;
  onOpenFile?: (path: string) => void;
}

const PREVIEW_LANGUAGE_BY_EXT: Record<string, BundledLanguage> = {
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
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
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
  'docx',
  'pptx',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'ods',
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

function parentDirOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

function ancestorDirsForPath(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const dirs = ['.'];
  let current = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    dirs.push(current);
  }
  return dirs;
}


function extOf(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function editorLanguageForPath(path: string): string {
  const extension = extOf(path);
  if (extension === 'jsx') return 'javascript';
  if (extension === 'sh') return 'shell';
  if (extension === 'tsx') return 'typescript';
  return PREVIEW_LANGUAGE_BY_EXT[extension] ?? 'plaintext';
}


function mediaKindForPath(path: string): MediaKind | null {
  const ext = extOf(path);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

function shouldUseHexPreview(path: string): boolean {
  const ext = extOf(path);
  return (mediaKindForPath(path) != null && ext !== 'svg') || BINARY_EXTENSIONS.has(ext);
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
  readOnly = false,
  shareAccess,
  showAttach = true,
  showShare = true,
  showBrowser = true,
  fileScope = 'thread',
  onClose,
  onAttach,
  onOpenFile,
}: Props) {
  const workspaceContext = useWorkspaceFileContext();
  const threadId = shareAccess?.threadId ?? (fileScope === 'user' ? '@user' : workspaceContext.threadId);
  const { notify } = useNotifications();
  const [currentPath, setCurrentPath] = useState('.');
  const [treeWidth, setTreeWidth] = useState(270);
  const [showTree, setShowTree] = useState(() => !compact || !previewPath);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['.']));
  const [treeEntries, setTreeEntries] = useState<Record<string, RemoteFileEntry[]>>({});
  const [directorySizes, setDirectorySizes] = useState<Record<string, number>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<number | undefined>();
  const [selectedUpdatedAt, setSelectedUpdatedAt] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [chunks, setChunks] = useState<PreviewChunk[]>([]);
  const [hexPreview, setHexPreview] = useState<FileHexPreview | null>(null);
  const [hexRows, setHexRows] = useState<FileHexRow[]>([]);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source' | 'edit'>('preview');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editOriginal, setEditOriginal] = useState('');
  const [editVersion, setEditVersion] = useState<FileTextVersion | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [rawUrl, setRawUrl] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [customShareValue, setCustomShareValue] = useState('1');
  const [customShareUnit, setCustomShareUnit] = useState<typeof CUSTOM_UNITS[number]['value']>('day');
  const previewRequestRef = useRef(0);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingPreviewStartsRef = useRef<Set<number>>(new Set());
  const pendingHexOffsetsRef = useRef<Set<number>>(new Set());
  const textRequest = useRef<{ id: number; path: string | null }>({ id: 0, path: null });
  const currentThreadRef = useRef(threadId);
  currentThreadRef.current = threadId;

  async function loadTreeDir(path: string) {
    const data = await listRemoteFiles(path, threadId);
    if (currentThreadRef.current !== threadId) return data;
    setTreeEntries((current) => ({ ...current, [data.path]: data.entries }));
    setDirectorySizes((current) => ({ ...current, [data.path]: data.totalSize }));
    return data;
  }

  async function loadDir(path = currentPath, select = true) {
    setLoading(true);
    setError(null);
    try {
      const data = await loadTreeDir(path);
      if (select) setCurrentPath(data.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function openFile(path: string, size?: number, startLine = 1, requestedMode?: 'source') {
    if (startLine > 1 && pendingPreviewStartsRef.current.has(startLine)) return;
    if (startLine === 1 && editorDirty && selectedPath && path !== selectedPath) {
      setError('当前文件有未保存修改，请先保存或重新加载');
      return;
    }
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    const mediaKind = mediaKindForPath(path);
    const hexPreviewFile = shouldUseHexPreview(path);
    const renderable = ['html', 'htm', 'md', 'csv', 'tsv'].includes(extOf(path));
    if (startLine === 1) {
      textRequest.current.id += 1;
      textRequest.current.path = null;
      setEditLoading(false);
      if (compact) setShowTree(false);
      pendingPreviewStartsRef.current.clear();
      pendingHexOffsetsRef.current.clear();
      setSelectedPath(path);
      setSelectedSize(size);
      setSelectedUpdatedAt(null);
      setPreview(null);
      setChunks([]);
      setHexPreview(null);
      setHexRows([]);
      setEditContent('');
      setEditOriginal('');
      setEditVersion(null);
      setEditError(null);
      setRawUrl('');
      setDownloadUrl('');
      setShareOpen(false);
      setPreviewMode(requestedMode ?? (renderable || mediaKind || officePreviewKindForPath(path) ? 'preview' : 'source'));
    } else {
      pendingPreviewStartsRef.current.add(startLine);
    }
    setLoading(true);
    setError(null);
    try {
      if (hexPreviewFile) {
        const data = await previewRemoteFileHex(path, 0, INITIAL_HEX_BYTES, { share: shareAccess, threadId });
        if (previewRequestRef.current !== requestId) return;
        setSelectedPath(data.path);
        setSelectedSize(size ?? data.size);
        setSelectedUpdatedAt(data.updatedAt);
        setHexPreview(data);
        setHexRows(data.rows);
        return;
      }

      const limit = startLine === 1 ? INITIAL_PREVIEW_LINES : MORE_PREVIEW_LINES;
      const data = await previewRemoteFile(path, startLine, limit, { render: startLine === 1 && renderable && requestedMode !== 'source', source: true, share: shareAccess, threadId });
      if (previewRequestRef.current !== requestId) return;
      setSelectedPath(data.path);
      setSelectedSize(size ?? data.size);
      setSelectedUpdatedAt(data.updatedAt);
      if (data.binary) {
        const hex = await previewRemoteFileHex(path, 0, INITIAL_HEX_BYTES, { share: shareAccess, threadId });
        if (previewRequestRef.current !== requestId) return;
        setHexPreview(hex);
        setHexRows(hex.rows);
        setPreviewMode('source');
        return;
      }
      setPreview(data);
      const nextChunk = { startLine: data.startLine, lines: data.lines };
      setChunks((current) => startLine === 1 ? [nextChunk] : [...current, nextChunk]);
      if (startLine === 1 && !renderable && !mediaKind && !officePreviewKindForPath(path) && data.size <= MAX_TEXT_FILE_BYTES) void openText(path, 'source');
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
      const data = await previewRemoteFileHex(selectedPath, offset, MORE_HEX_BYTES, { share: shareAccess, threadId });
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

  async function openText(path = selectedPath, mode: 'source' | 'edit' = 'edit', reload = false) {
    if (!path || (mode === 'edit' && (readOnly || shareAccess))) return;
    setPreviewMode(mode);
    if (!reload && editVersion && path === selectedPath) return;
    if (textRequest.current.path === path) return;
    const textRequestId = ++textRequest.current.id;
    textRequest.current.path = path;
    const requestId = previewRequestRef.current;
    setEditLoading(true);
    setEditError(null);
    try {
      const data = await getRemoteFileContent(path, threadId, shareAccess);
      if (textRequest.current.id !== textRequestId || previewRequestRef.current !== requestId || currentThreadRef.current !== threadId) return;
      setSelectedSize(data.version.size);
      setSelectedUpdatedAt(new Date(data.version.mtimeMs).toISOString());
      setEditContent(data.content);
      setEditOriginal(data.content);
      setEditVersion(data.version);
    } catch (err) {
      if (textRequest.current.id === textRequestId) setEditError((err as Error).message);
    } finally {
      if (textRequest.current.id === textRequestId) {
        textRequest.current.path = null;
        setEditLoading(false);
      }
    }
  }

  async function saveEditor(force = false) {
    if (!selectedPath || !editVersion || editLoading || editSaving || (!force && !editorDirty)) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const saved = await saveRemoteFileContent(selectedPath, editContent, editVersion.sha256, { force, threadId });
      const lines = editContent.split(/\r?\n/);
      setSelectedPath(saved.path);
      setSelectedSize(saved.size);
      setSelectedUpdatedAt(new Date(saved.version.mtimeMs).toISOString());
      setEditOriginal(editContent);
      setEditVersion(saved.version);
      setPreview({
        path: saved.path,
        size: saved.size,
        updatedAt: new Date(saved.version.mtimeMs).toISOString(),
        mode: 'full',
        startLine: 1,
        lines,
        totalLines: lines.length,
        nextLine: null,
        hasMore: false,
      });
      setChunks([{ startLine: 1, lines }]);
      notify({ variant: 'success', title: '文件已保存', description: saved.path });
      setPreviewMode('edit');
      if (showBrowser) void loadDir(currentPath, false);
      window.dispatchEvent(new CustomEvent('runforge:files-changed', { detail: { threadId } }));
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setEditSaving(false);
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

  async function revealSelectedInTree() {
    if (!selectedPath || loading) return;
    const dirs = ancestorDirsForPath(selectedPath);
    setShowTree(true);
    setLoading(true);
    setError(null);
    try {
      for (const dir of dirs) {
        if (!treeEntries[dir]) await loadTreeDir(dir);
      }
      setCurrentPath(parentDirOf(selectedPath));
      setExpanded((current) => {
        const next = new Set(current);
        dirs.forEach((dir) => next.add(dir));
        return next;
      });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          treeScrollRef.current
            ?.querySelector('[data-current-open-file="true"]')
            ?.scrollIntoView({ block: 'nearest' });
        });
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function selectFile(entry: RemoteFileEntry) {
    if (onOpenFile && entry.path !== selectedPath) {
      onOpenFile(entry.path);
      return;
    }
    void openFile(entry.path, entry.size);
  }

  useEffect(() => {
    if (!open || !showBrowser) return;
    setCurrentPath('.');
    setExpanded(new Set(['.']));
    setTreeEntries({});
    setDirectorySizes({});
    previewRequestRef.current += 1;
    setEditLoading(false);
    if (previewPath) void loadTreeDir('.');
    else void loadDir('.');
    // thread 切换必须清空旧目录缓存，避免在新 workspace 面板里短暂展示上一会话文件。
  }, [open, showBrowser, threadId]);

  useEffect(() => {
    if (!open || !previewPath) return;
    if (!showBrowser) {
      void openFile(previewPath);
      return;
    }
    const path = previewPath.replace(/\/+$/, '') || '.';
    let canceled = false;
    // 文件链接和目录链接共用预览入口；通过父目录的真实条目类型决定展示内容。
    void (async () => {
      if (path === '.') {
        await loadDir('.');
        if (!canceled) setShowTree(true);
        return;
      }
      try {
        const parent = await listRemoteFiles(parentDirOf(path), threadId);
        if (canceled) return;
        const entry = parent.entries.find((item) => item.path === path);
        if (entry?.type !== 'dir') {
          void openFile(path, entry?.size);
          return;
        }
        const dirs = [...ancestorDirsForPath(path), path];
        const listings = await Promise.all(dirs.map((dir) => listRemoteFiles(dir, threadId)));
        if (canceled) return;
        setTreeEntries((current) => ({ ...current, ...Object.fromEntries(listings.map((listing) => [listing.path, listing.entries])) }));
        setCurrentPath(path);
        setExpanded(new Set(dirs));
        setSelectedPath(null);
        setShowTree(true);
      } catch (err) {
        if (!canceled) setError((err as Error).message);
      }
    })();
    return () => { canceled = true; };
  }, [open, previewPath, threadId]);

  useEffect(() => {
    if (!compact) return;
    setShowTree(!previewPath);
  }, [compact, previewPath]);

  const editorLanguage = selectedPath ? editorLanguageForPath(selectedPath) : 'plaintext';
  const selectedExt = selectedPath ? extOf(selectedPath) : '';
  const selectedMediaKind = selectedPath ? mediaKindForPath(selectedPath) : null;
  const selectedOfficeKind = selectedPath ? officePreviewKindForPath(selectedPath) : null;
  const selectedUsesHexPreview = Boolean(hexPreview) || Boolean(selectedPath && shouldUseHexPreview(selectedPath));
  const selectedIsHtml = ['html', 'htm'].includes(selectedExt);
  const selectedIsMarkdown = selectedExt === 'md';
  const selectedTableFormat = selectedExt === 'csv' || selectedExt === 'tsv' ? selectedExt : null;
  const selectedCanRender = (!selectedUsesHexPreview && (selectedIsHtml || selectedIsMarkdown || selectedTableFormat != null)) || selectedMediaKind != null || selectedOfficeKind != null;
  const selectedCanSource = Boolean(selectedPath);
  const selectedCanEdit = Boolean(
    selectedPath
    && preview && !preview.binary
    && (selectedSize ?? Infinity) <= MAX_TEXT_FILE_BYTES
    && !readOnly
    && !shareAccess
    && selectedPath !== 'plugins'
    && !selectedPath.startsWith('plugins/')
    && !selectedUsesHexPreview
    && (!selectedMediaKind || selectedExt === 'svg')
    && !selectedOfficeKind,
  );
  const selectedCanPreview = Boolean(selectedPath && selectedCanRender);
  const editorDirty = editContent !== editOriginal;
  const editorTheme = typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light';
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
  const totalLines = preview?.totalLines ?? null;

  useEffect(() => {
    if (!open || previewMode !== 'edit' || !selectedCanEdit) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void saveEditor();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [open, previewMode, selectedCanEdit, selectedPath, editVersion, editorDirty, editLoading, editSaving, editContent]);

  useEffect(() => {
    let canceled = false;
    setRawUrl('');
    if (!selectedPath || !selectedMediaKind) return () => {
      canceled = true;
    };
    const rawUrlPromise = shareAccess
      ? Promise.resolve(signedRemoteFileUrl(selectedPath, shareAccess))
      : signedRemoteFileRawUrl(selectedPath, RAW_URL_TTL_SECONDS, threadId);
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
  }, [selectedMediaKind, selectedPath, shareAccess, threadId]);

  useEffect(() => {
    let canceled = false;
    setDownloadUrl('');
    if (!selectedPath) return () => {
      canceled = true;
    };
    const rawUrlPromise = shareAccess
      ? Promise.resolve(signedRemoteFileUrl(selectedPath, shareAccess))
      : signedRemoteFileRawUrl(selectedPath, RAW_URL_TTL_SECONDS, threadId);
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
  }, [selectedPath, shareAccess, threadId]);

  async function copyShareLink(ttlSeconds: number) {
    if (!selectedPath || shareBusy) return;
    setShareBusy(true);
    setError(null);
    try {
      const link = await createRemoteFileShareLink(selectedPath, clampShareTtl(ttlSeconds), threadId);
      await navigator.clipboard?.writeText(new URL(link.url, window.location.origin).toString());
      setShareOpen(false);
      notify({
        variant: 'success',
        title: '分享链接已复制',
        description: `到期 ${formatExpiresAt(link.expiresAt)}`,
      });
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      notify({ variant: 'error', title: '分享链接生成失败', description: message });
    } finally {
      setShareBusy(false);
    }
  }

  const customUnit = CUSTOM_UNITS.find((unit) => unit.value === customShareUnit) ?? CUSTOM_UNITS[2];
  const customShareSeconds = clampShareTtl((Number(customShareValue) || 0) * customUnit.seconds);

  if (!open) return null;
  const hasMoreHex = selectedUsesHexPreview && Boolean(hexPreview?.hasMore && hexPreview.nextOffset != null);
  const showPanelHeader = !embedded;
  const showHeaderTreeToggle = showBrowser && !selectedPath;
  const showTreePlaceholder = showBrowser && showTree && !selectedPath;
  const showTreeSide = showBrowser && showTree && Boolean(selectedPath);

  const renderRows = (entries: RemoteFileEntry[] | undefined, depth: number): JSX.Element[] =>
    (entries ?? []).flatMap((entry) => {
      const isDir = entry.type === 'dir';
      const isOpen = expanded.has(entry.path);
      const selected = entry.path === selectedPath || entry.path === currentPath;
      const row = (
        <button
          key={entry.path}
          className={cn(
            'group/file flex min-h-11 w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-[13px] hover:bg-accent/70',
            selected && 'bg-accent text-accent-foreground',
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => isDir ? void toggleDir(entry.path) : selectFile(entry)}
          title={entry.path}
          data-current-open-file={!isDir && entry.path === selectedPath ? 'true' : undefined}
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
          <span className="min-w-0 flex-1">
            <span className="block truncate">{entry.name}</span>
            <span className="flex items-center justify-between gap-2 text-[10px] leading-4 text-muted-foreground">
              <span className="shrink-0">{formatFileSize(entry.size)}</span>
              <time className="min-w-0 truncate text-right" dateTime={entry.updatedAt} title={formatFileDate(entry.updatedAt)}>{formatFileDate(entry.updatedAt)}</time>
            </span>
          </span>
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
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">文件</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void revealSelectedInTree()}
            disabled={!selectedPath || loading}
            title="定位当前文件"
            aria-label="定位当前文件"
          >
            <LocateFixed className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void loadDir(currentPath, false)}
            disabled={loading}
            title="刷新文件树"
            aria-label="刷新文件树"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <div ref={treeScrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
        <button
          className={cn(
            'flex h-7 w-full items-center gap-1.5 px-2 text-left text-[13px] hover:bg-accent/70',
            currentPath === '.' && 'bg-accent text-accent-foreground',
          )}
          onClick={() => void toggleDir('.')}
          title="工作区"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded.has('.') && 'rotate-90')} />
          {expanded.has('.') ? <FolderOpen className="size-4 shrink-0 text-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{fileScope === 'user' ? '我的文件' : '工作区'}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{directorySizes['.'] == null ? '' : formatFileSize(directorySizes['.'])}</span>
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
          {showBrowser && showHeaderTreeToggle && (
            <Button
              variant={showTree ? 'secondary' : 'ghost'}
              size="icon"
              onClick={() => setShowTree((value) => !value)}
              title={showTree ? '隐藏文件树' : '显示文件树'}
            >
              {showTree ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            </Button>
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
          {showTreePlaceholder ? (
            renderTreeBrowser(false)
          ) : selectedPath ? (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <div className="min-w-48 flex-1">
                  <div className="truncate text-sm font-medium">{selectedPath}</div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{selectedSize == null ? '' : formatFileSize(selectedSize)}{!selectedUsesHexPreview && totalLines != null ? ` · ${totalLines} 行` : ''}</span>
                    {selectedUpdatedAt && <time className="shrink-0 whitespace-nowrap text-right" dateTime={selectedUpdatedAt}>{formatFileDate(selectedUpdatedAt)}</time>}
                  </div>
                </div>
                {(selectedCanPreview || selectedCanSource || selectedCanEdit) && (
                  <div className="flex rounded-md border bg-background p-0.5">
                    {selectedCanPreview && (
                      <Button
                        variant={previewMode === 'preview' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => {
                          if (selectedTableFormat && (!chunks.length || preview?.hasMore)) void openFile(selectedPath, selectedSize);
                          else setPreviewMode('preview');
                        }}
                        title={selectedOfficeKind ? '预览文档' : selectedMediaKind ? '预览媒体' : selectedTableFormat ? '预览表格' : selectedIsHtml ? '渲染 HTML' : '渲染 Markdown'}
                      >
                        <Eye className="size-4" />
                        <span>预览</span>
                      </Button>
                    )}
                    {selectedCanSource && (
                      <Button
                        variant={previewMode === 'source' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => {
                          setPreviewMode('source');
                          if (!selectedUsesHexPreview && (selectedSize ?? Infinity) <= MAX_TEXT_FILE_BYTES) void openText(selectedPath, 'source');
                          else if (!selectedUsesHexPreview && !chunks.length) void openFile(selectedPath, selectedSize, 1, 'source');
                        }}
                        title={selectedUsesHexPreview ? '查看二进制' : '查看原文'}
                        aria-label={selectedUsesHexPreview ? '查看二进制' : '查看原文'}
                      >
                        <Code2 className="size-4" />
                        <span>{selectedUsesHexPreview ? '二进制' : '原文'}</span>
                      </Button>
                    )}
                    {selectedCanEdit && (
                      <Button
                        variant={previewMode === 'edit' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => void openText()}
                        title="编辑文件"
                      >
                        <Pencil className="size-4" />
                        <span>编辑</span>
                      </Button>
                    )}
                  </div>
                )}
                {selectedCanEdit && previewMode === 'edit' && (
                  <>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      onClick={() => void saveEditor()}
                      disabled={!editorDirty || editLoading || editSaving || !editVersion}
                      title="保存 (Ctrl/Cmd+S)"
                      aria-label="保存"
                    >
                      <Save className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void openText(selectedPath, 'edit', true)}
                      disabled={editLoading || editSaving}
                      title="重新加载"
                      aria-label="重新加载"
                    >
                      <RotateCcw className={cn('size-4', editLoading && 'animate-spin')} />
                    </Button>
                  </>
                )}
                {showAttach && !readOnly && (
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
                {showShare && !readOnly && (
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
                {showBrowser && (
                  <Button
                    variant={showTree ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    onClick={() => setShowTree((value) => !value)}
                    title={showTree ? '隐藏文件树' : '显示文件树'}
                    aria-label={showTree ? '隐藏文件树' : '显示文件树'}
                  >
                    {showTree ? <PanelRightClose className="size-4" /> : <FolderTree className="size-4" />}
                  </Button>
                )}
              </div>
              <div className="min-h-0 flex-1">
                {selectedCanEdit && previewMode === 'edit' ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-background">
                    {editError && (
                      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-destructive">
                        <span className="min-w-0 flex-1 truncate" title={editError}>{editError}</span>
                        {editError.startsWith('409 ') && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            onClick={() => void saveEditor(true)}
                            disabled={editSaving || editLoading}
                            title="覆盖保存"
                          >
                            覆盖保存
                          </Button>
                        )}
                      </div>
                    )}
                    {editLoading && !editVersion ? (
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在打开编辑器…</div>
                    ) : editVersion ? (
                      <MonacoErrorBoundary key={`edit:${selectedPath}`}>
                        <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载编辑器…</div>}>
                          <MonacoTextEditor
                            language={editorLanguage}
                            path={`${threadId}/${selectedPath}`}
                            theme={editorTheme}
                            value={editContent}
                            onChange={setEditContent}
                            onSave={() => void saveEditor()}
                          />
                        </Suspense>
                      </MonacoErrorBoundary>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">无法打开编辑器</div>
                    )}
                  </div>
                ) : selectedMediaKind === 'image' && previewMode === 'preview' ? (
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
                ) : selectedOfficeKind && previewMode === 'preview' ? (
                  <OfficePreview path={selectedPath} kind={selectedOfficeKind} shareAccess={shareAccess} />
                ) : selectedUsesHexPreview && previewMode === 'source' && hexRows.length > 0 ? (
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
                ) : selectedUsesHexPreview && previewMode === 'source' && hexPreview ? (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
                    暂无二进制内容
                  </div>
                ) : selectedUsesHexPreview && previewMode === 'source' ? (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
                    正在加载二进制内容…
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
                ) : selectedTableFormat && chunks.length > 0 && previewMode === 'preview' ? (
                  <DelimitedTextPreview key={`${threadId}:${selectedPath}`} source={previewCode} format={selectedTableFormat} />
                ) : previewMode === 'source' && !selectedUsesHexPreview ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-background">
                    {editError && <div className="border-b px-3 py-2 text-xs text-destructive">{editError}</div>}
                    <div className="min-h-0 flex-1">
                      <MonacoErrorBoundary key={`source:${threadId}:${selectedPath}`}>
                        <Suspense fallback={<div className="p-3 text-sm text-muted-foreground">正在加载原文…</div>}>
                          <MonacoTextEditor
                            path={`${threadId}/${selectedPath}`} language={editorLanguage} theme={editorTheme}
                            value={editVersion ? editOriginal : previewCode} readOnly
                            onReachEnd={preview?.nextLine ? () => void openFile(selectedPath, selectedSize, preview.nextLine ?? 1) : undefined}
                          />
                        </Suspense>
                      </MonacoErrorBoundary>
                    </div>
                    {preview?.hasMore && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void openFile(selectedPath, selectedSize, preview.nextLine ?? 1)}>{loading ? '正在加载…' : '加载更多原文'}</Button>}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground">
                    暂无预览内容
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-muted-foreground">选择一个文件</div>
          )}
        </div>
        {showTreeSide && (
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
