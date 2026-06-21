import rawMermaid, { type MermaidConfig } from 'mermaid';
import { CopyIcon, DownloadIcon, Maximize2Icon, RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import {
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CodeBlock as StreamdownCodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  defaultRemarkPlugins,
  StreamdownContext,
  type ControlsConfig,
  type StreamdownProps,
  type UrlTransform,
  useIsCodeFenceIncomplete,
} from 'streamdown';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { remoteFileRawUrl } from '@/api';

interface MarkdownRenderOptions {
  streaming?: boolean;
}

const MarkdownRenderOptionsContext = createContext<MarkdownRenderOptions>({});

export function MarkdownRenderOptionsProvider({ children, value }: { children: ReactNode; value: MarkdownRenderOptions }) {
  return (
    <MarkdownRenderOptionsContext.Provider value={value}>
      {children}
    </MarkdownRenderOptionsContext.Provider>
  );
}

type MarkdownCodeProps = ComponentProps<'code'> & {
  node?: { properties?: { metastring?: string } };
  children?: ReactNode;
  'data-block'?: string | boolean;
};

type MarkdownImageProps = ComponentProps<'img'>;

const LANGUAGE_CLASS_RE = /language-([^\s]+)/;
const START_LINE_RE = /showLineNumbers\{(\d+)\}/;
const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#].*)?$/i;

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

function normalizedRenderWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.max(320, Math.round(width));
}

function normalizedRenderSize(width: number, height: number): { width: number; height: number } {
  return {
    height: Math.max(240, Math.round(height)),
    width: normalizedRenderWidth(width),
  };
}

function isXyChart(chart: string): boolean {
  return /^\s*xychart(?:-beta)?\b/im.test(chart);
}

function mermaidResizeTargets(element: HTMLElement): Element[] {
  const targets: Element[] = [element];
  let current = element.parentElement;
  while (current && targets.length < 8) {
    targets.push(current);
    current = current.parentElement;
  }
  return targets;
}

function mermaidRenderConfig(
  chart: string,
  baseConfig: MermaidConfig,
  config: MermaidConfig | undefined,
  renderSize: { width: number; height: number },
): MermaidConfig {
  const nextConfig: MermaidConfig = { ...baseConfig, ...config };

  if (isXyChart(chart)) {
    return {
      ...nextConfig,
      xyChart: {
        ...nextConfig.xyChart,
        // xychart 会用配置里的 width/height 生成 SVG 尺寸，不能只依赖外层 CSS 拉伸。
        height: renderSize.height,
        width: renderSize.width,
      },
    };
  }

  return nextConfig;
}

function downloadText(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function createMermaidRenderHost(width: number, height: number): HTMLDivElement {
  const host = document.createElement('div');
  host.style.background = 'transparent';
  host.style.contain = 'layout style paint';
  host.style.height = `${height}px`;
  host.style.left = '-10000px';
  host.style.maxWidth = `${width}px`;
  host.style.minWidth = `${width}px`;
  host.style.opacity = '0';
  host.style.overflow = 'hidden';
  host.style.pointerEvents = 'none';
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.width = `${width}px`;
  host.style.zIndex = '-1';
  document.body.appendChild(host);
  return host;
}

function numericSvgLength(value: string | null): number | null {
  if (!value) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function svgNaturalSize(svg: string): { width: number; height: number } {
  // Mermaid 输出通常带 viewBox，优先用它读取这次原生渲染后的真实尺寸。
  const viewBox = svg.match(/\bviewBox=(["'])([^"']+)\1/i)?.[2]
    ?.trim()
    .split(/[\s,]+/)
    .map((item) => Number.parseFloat(item));
  if (viewBox && viewBox.length === 4 && viewBox.every((item) => Number.isFinite(item)) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  const width = numericSvgLength(svg.match(/\bwidth=(["'])([^"']+)\1/i)?.[2] ?? null);
  const height = numericSvgLength(svg.match(/\bheight=(["'])([^"']+)\1/i)?.[2] ?? null);
  return { width: width ?? 960, height: height ?? 540 };
}

function renderedMermaidSvgSize(svg: string): { svg: string; width: number; height: number } {
  const naturalSize = svgNaturalSize(svg);
  return { svg, width: naturalSize.width, height: naturalSize.height };
}

function flowchartDirection(chart: string): 'horizontal' | 'vertical' | null {
  const firstDiagramLine = chart
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('%%'));
  if (!firstDiagramLine || !/^(flowchart|graph)\b/i.test(firstDiagramLine)) return null;

  const direction = chart.match(/^\s*(?:flowchart|graph)\s+(LR|RL|TB|TD|BT)\b/im)?.[1]
    ?? chart.match(/^\s*direction\s+(LR|RL|TB|TD|BT)\b/im)?.[1]
    ?? 'TB';
  return direction === 'LR' || direction === 'RL' ? 'horizontal' : 'vertical';
}

function shouldRefitFlowchart(chart: string, actualWidth: number, targetWidth: number): boolean {
  return Boolean(flowchartDirection(chart) && actualWidth > 0 && targetWidth > actualWidth * 1.12);
}

function flowchartFitSpacing(actualWidth: number, targetWidth: number): number {
  const ratio = Math.max(1, targetWidth / Math.max(1, actualWidth));
  return Math.min(260, Math.max(50, Math.round(50 * ratio)));
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

function MermaidViewport({ height, svg, fullscreen = false, width }: { height: number; svg: string; fullscreen?: boolean; width: number }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, pointerY: 0, panX: 0, panY: 0 });
  const naturalSize = useMemo(() => ({ height, width }), [height, width]);

  const zoomBy = useCallback((delta: number) => {
    setZoom((value) => Math.max(0.5, Math.min(3, Number((value + delta).toFixed(2)))));
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    resetView();
  }, [resetView, svg]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateFitScale = () => {
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (!fullscreen) {
        setFitScale(1);
        return;
      }
      const padding = fullscreen ? 16 : 24;
      const availableWidth = Math.max(1, rect.width - padding);
      const availableHeight = Math.max(1, rect.height - padding);
      const fitWidth = availableWidth / naturalSize.width;
      const fitBoth = Math.min(fitWidth, availableHeight / naturalSize.height);
      const next = Math.min(3, Math.max(0.2, fitBoth));
      setFitScale(Number(next.toFixed(3)));
    };

    // 外层宽度切换、右侧栏开合、全屏变化都会触发重新计算视图尺寸。
    updateFitScale();
    const observer = new ResizeObserver(updateFitScale);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fullscreen, naturalSize.height, naturalSize.width, svg]);

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
          style={{
            height: `${naturalSize.height}px`,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${fitScale * zoom})`,
            transformOrigin: 'center center',
            width: `${naturalSize.width}px`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

function MermaidFullscreen({
  height,
  open,
  onOpenChange,
  svg,
  width,
}: {
  height: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  svg: string;
  width: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden bg-background/95 p-4 sm:rounded-lg">
        <DialogTitle className="sr-only">Mermaid 全屏预览</DialogTitle>
        <div className="flex min-h-0 flex-1 items-center justify-center">
        <div data-streamdown="mermaid" className="mermaid-fullscreen size-full">
          <MermaidViewport height={height} svg={svg} fullscreen width={width} />
        </div>
      </div>
      </DialogContent>
    </Dialog>
  );
}

function EagerMermaidBlock({ chart, className, isIncomplete }: { chart: string; className?: string; isIncomplete: boolean }) {
  const { controls, mermaid } = useContext(StreamdownContext);
  const { streaming } = useContext(MarkdownRenderOptionsContext);
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '-');
  const diagramRef = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState('');
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 });

  const config = mermaid?.config;
  const ErrorComponent = mermaid?.errorComponent;
  const showCopy = getControl(controls, 'mermaid', 'copy');
  const showDownload = getControl(controls, 'mermaid', 'download');
  const showFullscreen = getControl(controls, 'mermaid', 'fullscreen');
  const showPanZoom = getControl(controls, 'mermaid', 'panZoom');
  const showActions = !isIncomplete && (showCopy || showDownload || showFullscreen);

  useLayoutEffect(() => {
    const element = diagramRef.current;
    if (!element) return;
    let frame = 0;
    let settleTimer = 0;
    const updateSize = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const next = normalizedRenderSize(element.clientWidth || rect.width, element.clientHeight || rect.height);
      setRenderSize((current) => (next.width && next.height && (next.width !== current.width || next.height !== current.height) ? next : current));
    };
    const scheduleUpdate = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateSize);
      if (settleTimer) window.clearTimeout(settleTimer);
      // 右侧栏动画和加宽切换可能分多帧完成，补一次收敛后的真实尺寸。
      settleTimer = window.setTimeout(updateSize, 220);
    };
    updateSize();
    const observer = new ResizeObserver(() => {
      scheduleUpdate();
    });
    mermaidResizeTargets(element).forEach((target) => observer.observe(target));
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (settleTimer) window.clearTimeout(settleTimer);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, []);

  useEffect(() => {
    if ((isIncomplete && !streaming) || !renderSize.width || !renderSize.height) return;

    let canceled = false;
    const renderId = `mermaid-${reactId}-${hashString(chart)}-${renderSize.width}x${renderSize.height}-${retry}`;

    setLoading(true);
    setError(null);

    void (async () => {
      let renderHost: HTMLDivElement | null = null;
      try {
        renderHost = createMermaidRenderHost(renderSize.width, renderSize.height);
        const baseConfig: MermaidConfig = { fontFamily: 'monospace', securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true };
        const responsiveConfig = mermaidRenderConfig(chart, baseConfig, config, renderSize);
        rawMermaid.initialize(responsiveConfig);
        // 流式输出期间先做 Mermaid 基础语法校验；不通过就保留上一张有效图，等待下一次同步。
        await rawMermaid.parse(chart);
        // 宽度变化时在同宽离屏宿主里重新布局，生成目标宽度下的 SVG。
        const { svg: nextSvg } = await rawMermaid.render(renderId, chart, renderHost);
        let normalizedSvg = renderedMermaidSvgSize(nextSvg);
        for (let attempt = 0; attempt < 2 && shouldRefitFlowchart(chart, normalizedSvg.width, renderSize.width); attempt += 1) {
          const direction = flowchartDirection(chart);
          const spacing = flowchartFitSpacing(normalizedSvg.width, renderSize.width);
          const flowchartConfig = {
            ...responsiveConfig,
            flowchart: {
              ...responsiveConfig.flowchart,
              rankSpacing: direction === 'horizontal' ? spacing : responsiveConfig.flowchart?.rankSpacing,
              nodeSpacing: direction === 'vertical' ? spacing : responsiveConfig.flowchart?.nodeSpacing,
              useMaxWidth: false,
            },
          };
          rawMermaid.initialize(flowchartConfig);
          const { svg: fittedSvg } = await rawMermaid.render(`${renderId}-fit-${attempt}`, chart, renderHost);
          const fittedSize = renderedMermaidSvgSize(fittedSvg);
          if (fittedSize.width <= normalizedSvg.width + 2) break;
          normalizedSvg = fittedSize;
        }
        if (canceled) return;
        setError(null);
        setSvg(normalizedSvg.svg);
        setSvgSize({ width: normalizedSvg.width, height: normalizedSvg.height });
      } catch (reason) {
        if (canceled) return;
        if (streaming) {
          setError(null);
          return;
        }
        setSvg('');
        setSvgSize({ width: 0, height: 0 });
        setError(reason instanceof Error ? reason.message : 'Mermaid 图表渲染失败');
      } finally {
        renderHost?.remove();
        if (!canceled) setLoading(false);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [chart, config, isIncomplete, reactId, renderSize, retry, streaming]);

  const copySource = useCallback(() => {
    void navigator.clipboard?.writeText(chart);
  }, [chart]);

  const downloadSvg = useCallback(() => {
    if (svg) downloadText('diagram.svg', svg, 'image/svg+xml;charset=utf-8');
  }, [svg]);

  const retryRender = useCallback(() => setRetry((value) => value + 1), []);

  const body = useMemo(() => {
    if (!renderSize.width || !renderSize.height || (isIncomplete && !svg) || (loading && !svg) || (streaming && !svg && !error)) {
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
      <MermaidViewport height={svgSize.height || 1} svg={svg} width={svgSize.width || renderSize.width} />
    );
  }, [ErrorComponent, chart, error, isIncomplete, loading, renderSize.height, renderSize.width, retryRender, streaming, svg, svgSize.height, svgSize.width]);

  return (
    <div
      data-streamdown="mermaid-block"
      className={cn('group relative my-4 flex w-full flex-col gap-2 rounded-md border border-border bg-white p-2 dark:bg-[#1f2020]', className)}
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
      <div
        ref={diagramRef}
        data-streamdown="mermaid"
        className="h-[min(70vh,32rem)] min-h-60 rounded-md border border-border bg-white dark:bg-[#1f2020]"
      >
        {showPanZoom ? (
          body
        ) : (
          <div className="flex size-full items-center justify-center overflow-auto">
            {svg ? (
              <div
                className="mermaid-svg-shell"
                style={{ height: `${svgSize.height || 1}px`, width: `${svgSize.width || renderSize.width}px` }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              body
            )}
          </div>
        )}
      </div>
      {svg ? (
        <MermaidFullscreen
          height={svgSize.height || 1}
          open={fullscreenOpen}
          onOpenChange={setFullscreenOpen}
          svg={svg}
          width={svgSize.width || renderSize.width}
        />
      ) : null}
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

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isWorkspaceFileUrl(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith('#')) return false;
  if (isInlineOrRemoteImage(normalized) || normalized.startsWith('/api/files/raw')) return false;
  if (/^(?:blob:|file:|javascript:|vbscript:)/i.test(normalized)) return false;
  return !(normalized.startsWith('//') || hasUrlScheme(normalized));
}

function isInlineOrRemoteImage(src: string): boolean {
  return /^(?:https?:|data:|\/api\/files\/raw\b)/i.test(src);
}

function resolveMarkdownImageSource(src: string): string | undefined {
  const normalized = src.trim();
  if (!normalized) return src;
  if (isInlineOrRemoteImage(normalized)) return normalized;

  // blob/file/javascript 这类地址不能作为持久化 Markdown 图片源，避免浏览器显示 blocked。
  if (/^(?:blob:|file:|javascript:|vbscript:)/i.test(normalized)) return undefined;

  if (normalized.startsWith('//') || hasUrlScheme(normalized)) return normalized;
  return remoteFileRawUrl(normalized);
}

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  type?: string;
  url?: unknown;
};

function visitMarkdownAst(node: MarkdownAstNode, visitor: (node: MarkdownAstNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) visitMarkdownAst(child, visitor);
}

function remarkWorkspaceFileUrls() {
  return (tree: MarkdownAstNode) => {
    visitMarkdownAst(tree, (node) => {
      if (typeof node.url !== 'string' || !isWorkspaceFileUrl(node.url)) return;
      if (node.type === 'image') {
        node.url = remoteFileRawUrl(node.url);
        return;
      }
      if ((node.type === 'link' || node.type === 'definition') && IMAGE_PATH_RE.test(node.url)) {
        node.url = remoteFileRawUrl(node.url);
      }
    });
  };
}

export const markdownRemarkPlugins: NonNullable<StreamdownProps['remarkPlugins']> = [
  ...Object.values(defaultRemarkPlugins),
  remarkWorkspaceFileUrls,
];

export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img') return resolveMarkdownImageSource(url);
  return url;
};

function normalizeImageSrc(src: string): string | undefined {
  return resolveMarkdownImageSource(src);
}

function StreamdownImage({ className, src, alt = '', ...props }: MarkdownImageProps) {
  const resolvedSrc = src ? normalizeImageSrc(src) : src;
  return (
    <img
      {...props}
      alt={alt}
      className={cn('my-3 max-h-[70vh] max-w-full rounded-md border border-border object-contain', className)}
      decoding="async"
      loading="lazy"
      src={resolvedSrc}
    />
  );
}

export function useStreamdownComponents(components?: StreamdownProps['components']): StreamdownProps['components'] {
  return useMemo(() => ({ ...components, code: StreamdownCode, img: StreamdownImage }), [components]);
}
