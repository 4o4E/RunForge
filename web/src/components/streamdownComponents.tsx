import { mermaid as mermaidPlugin } from '@streamdown/mermaid';
import { CopyIcon, DownloadIcon, Maximize2Icon, RotateCcwIcon, XIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import {
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  CodeBlock as StreamdownCodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  StreamdownContext,
  type ControlsConfig,
  type StreamdownProps,
  useIsCodeFenceIncomplete,
} from 'streamdown';
import { cn } from '@/lib/utils';

type MarkdownCodeProps = ComponentProps<'code'> & {
  node?: { properties?: { metastring?: string } };
  children?: ReactNode;
  'data-block'?: string | boolean;
};

const LANGUAGE_CLASS_RE = /language-([^\s]+)/;
const START_LINE_RE = /showLineNumbers\{(\d+)\}/;

function getControl(controls: ControlsConfig, scope: 'code' | 'mermaid', action?: string): boolean {
  if (controls === false) return false;
  if (controls === true || controls == null) return true;
  const scoped = controls[scope];
  if (scoped == null) return true;
  if (typeof scoped === 'boolean') return scoped;
  return action ? scoped[action as keyof typeof scoped] !== false : true;
}

function textFromReactNode(value: ReactNode): string {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textFromReactNode).join('');
  if (isValidElement(value)) return textFromReactNode((value.props as { children?: ReactNode }).children);
  return '';
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return String(Math.abs(hash));
}

function downloadText(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function IconButton({
  title,
  onClick,
  children,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function MermaidViewport({ svg, fullscreen = false }: { svg: string; fullscreen?: boolean }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, pointerY: 0, panX: 0, panY: 0 });

  const zoomBy = useCallback((delta: number) => {
    setZoom((value) => Math.max(0.5, Math.min(3, Number((value + delta).toFixed(2)))));
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      zoomBy(event.deltaY > 0 ? -0.1 : 0.1);
    };

    // wheel 必须使用 passive:false，否则浏览器可能忽略 preventDefault 并继续滚动页面。
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStartRef.current = { pointerX: event.clientX, pointerY: event.clientY, panX: pan.x, panY: pan.y };
      setDragging(true);
    },
    [pan.x, pan.y],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.preventDefault();
    const start = dragStartRef.current;
    setPan({
      x: start.panX + event.clientX - start.pointerX,
      y: start.panY + event.clientY - start.pointerY,
    });
  }, [dragging]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div className={cn('relative size-full overflow-hidden', fullscreen ? 'min-h-0' : null)}>
      <div className="absolute bottom-2 left-2 z-10 flex flex-col gap-1 rounded-md border border-border bg-background/80 p-1 supports-[backdrop-filter]:bg-background/70 supports-[backdrop-filter]:backdrop-blur-sm">
        <IconButton title="放大 Mermaid 图表" onClick={() => zoomBy(0.1)} disabled={zoom >= 3}>
          <ZoomInIcon className="size-4" />
        </IconButton>
        <IconButton title="缩小 Mermaid 图表" onClick={() => zoomBy(-0.1)} disabled={zoom <= 0.5}>
          <ZoomOutIcon className="size-4" />
        </IconButton>
        <IconButton title="重置 Mermaid 视图" onClick={resetView}>
          <RotateCcwIcon className="size-4" />
        </IconButton>
      </div>
      <div
        className={cn('flex size-full items-center justify-center overflow-hidden', dragging ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerCancel={onPointerUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={viewportRef}
      >
        {/* 拖动和缩放只改变视图层，不重新生成 Mermaid SVG。 */}
        <div
          aria-label="Mermaid chart"
          role="img"
          className="mermaid-svg-shell"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center center' }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

function MermaidFullscreen({
  open,
  onOpenChange,
  svg,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  svg: string;
}) {
  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onOpenChange, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onOpenChange(false);
      }}
      role="button"
      tabIndex={0}
    >
      <button
        type="button"
        className="absolute right-4 top-4 z-10 rounded-md p-2 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
        onClick={() => onOpenChange(false)}
        title="退出 Mermaid 全屏"
      >
        <XIcon className="size-5" />
      </button>
      <div
        className="flex size-full items-center justify-center p-4"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        <div data-streamdown="mermaid" className="mermaid-fullscreen size-full">
          <MermaidViewport svg={svg} fullscreen />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EagerMermaidBlock({ chart, className, isIncomplete }: { chart: string; className?: string; isIncomplete: boolean }) {
  const { controls, mermaid } = useContext(StreamdownContext);
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '-');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const config = mermaid?.config;
  const ErrorComponent = mermaid?.errorComponent;
  const showCopy = getControl(controls, 'mermaid', 'copy');
  const showDownload = getControl(controls, 'mermaid', 'download');
  const showFullscreen = getControl(controls, 'mermaid', 'fullscreen');
  const showPanZoom = getControl(controls, 'mermaid', 'panZoom');
  const showActions = !isIncomplete && (showCopy || showDownload || showFullscreen);

  useEffect(() => {
    if (isIncomplete) return;

    let canceled = false;
    const renderId = `mermaid-${reactId}-${hashString(chart)}-${retry}`;

    setLoading(true);
    setError(null);

    void mermaidPlugin
      .getMermaid(config)
      .render(renderId, chart)
      .then(({ svg: nextSvg }) => {
        if (canceled) return;
        setSvg(nextSvg);
      })
      .catch((reason: unknown) => {
        if (canceled) return;
        setError(reason instanceof Error ? reason.message : 'Mermaid 图表渲染失败');
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [chart, config, isIncomplete, reactId, retry]);

  const copySource = useCallback(() => {
    void navigator.clipboard?.writeText(chart);
  }, [chart]);

  const downloadSvg = useCallback(() => {
    if (svg) downloadText('diagram.svg', svg, 'image/svg+xml;charset=utf-8');
  }, [svg]);

  const retryRender = useCallback(() => setRetry((value) => value + 1), []);

  const body = useMemo(() => {
    if (isIncomplete || (loading && !svg)) {
      return (
        <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
          Mermaid 图表生成中...
        </div>
      );
    }

    if (error && !svg) {
      if (ErrorComponent) return <ErrorComponent chart={chart} error={error} retry={retryRender} />;
      return (
        <div className="flex size-full flex-col justify-center gap-3 overflow-auto p-4 text-sm">
          <div className="font-mono text-destructive">Mermaid Error: {error}</div>
          <button type="button" className="w-fit rounded border px-2 py-1 text-xs hover:bg-muted" onClick={retryRender}>
            重新渲染
          </button>
        </div>
      );
    }

    return (
      <MermaidViewport svg={svg} />
    );
  }, [ErrorComponent, chart, error, isIncomplete, loading, retryRender, svg]);

  return (
    <div
      data-streamdown="mermaid-block"
      className={cn('group relative my-4 flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2', className)}
    >
      <div className="flex h-8 items-center text-muted-foreground text-xs">
        <span className="ml-1 font-mono lowercase">mermaid</span>
      </div>
      {showActions ? (
        <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
          <div
            data-streamdown="mermaid-block-actions"
            className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
          >
            {showDownload ? (
              <IconButton title="下载 Mermaid SVG" onClick={downloadSvg} disabled={!svg}>
                <DownloadIcon className="size-4" />
              </IconButton>
            ) : null}
            {showCopy ? (
              <IconButton title="复制 Mermaid 源码" onClick={copySource}>
                <CopyIcon className="size-4" />
              </IconButton>
            ) : null}
            {showFullscreen ? (
              <IconButton title="全屏查看 Mermaid 图表" onClick={() => setFullscreenOpen(true)} disabled={!svg}>
                <Maximize2Icon className="size-4" />
              </IconButton>
            ) : null}
          </div>
        </div>
      ) : null}
      <div data-streamdown="mermaid" className="rounded-md border border-border bg-background">
        {showPanZoom ? body : <div className="flex size-full items-center justify-center overflow-auto">{svg ? <div className="mermaid-svg-shell" dangerouslySetInnerHTML={{ __html: svg }} /> : body}</div>}
      </div>
      {svg ? <MermaidFullscreen open={fullscreenOpen} onOpenChange={setFullscreenOpen} svg={svg} /> : null}
    </div>
  );
}

function StreamdownCode({ className, children, node, ...props }: MarkdownCodeProps) {
  const { controls, lineNumbers } = useContext(StreamdownContext);
  const isIncomplete = useIsCodeFenceIncomplete();
  const isBlock = 'data-block' in props;
  const language = className?.match(LANGUAGE_CLASS_RE)?.[1] ?? '';

  if (!isBlock) {
    return (
      <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-sm', className)} {...props}>
        {children}
      </code>
    );
  }

  const code = textFromReactNode(children);
  if (language === 'mermaid') return <EagerMermaidBlock chart={code} className={className} isIncomplete={isIncomplete} />;

  const startLineValue = node?.properties?.metastring?.match(START_LINE_RE)?.[1];
  const startLine = startLineValue ? Number.parseInt(startLineValue, 10) : undefined;
  const showCodeControls = getControl(controls, 'code');
  const showCopy = showCodeControls && getControl(controls, 'code', 'copy');
  const showDownload = showCodeControls && getControl(controls, 'code', 'download');

  return (
    <StreamdownCodeBlock code={code} language={language} isIncomplete={isIncomplete} lineNumbers={lineNumbers} startLine={startLine} className={className}>
      {showDownload ? <CodeBlockDownloadButton code={code} language={language} /> : null}
      {showCopy ? <CodeBlockCopyButton code={code} /> : null}
    </StreamdownCodeBlock>
  );
}

export function useStreamdownComponents(components?: StreamdownProps['components']): StreamdownProps['components'] {
  return useMemo(() => ({ ...components, code: StreamdownCode }), [components]);
}
