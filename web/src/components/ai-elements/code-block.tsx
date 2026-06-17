"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MarkdownContent } from "@/components/MarkdownContent";
import { streamdownPreviewPlugins } from "@/components/streamdownConfig";
import { cn } from "@/lib/utils";
import { AlignLeftIcon, CheckIcon, Code2Icon, CopyIcon, EyeIcon, MapIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, ErrorInfo, HTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import {
  Component,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemedToken,
} from "shiki";
import { createHighlighter } from "shiki";

// Shiki 的 fontStyle 是位标记：1=italic, 2=bold, 4=underline。
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) =>
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4;

interface KeyedToken {
  token: ThemedToken;
  key: string;
}
interface KeyedLine {
  tokens: KeyedToken[];
  key: string;
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }));

const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
    style={
      {
        backgroundColor: token.bgColor,
        color: token.color,
        fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
        fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
        textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
        ...token.htmlStyle,
      } as CSSProperties
    }
  >
    {token.content}
  </span>
);

const LineSpan = ({
  keyedLine,
  lineNumber,
  showLineNumbers,
  wrap,
}: {
  keyedLine: KeyedLine;
  lineNumber: number;
  showLineNumbers: boolean;
  wrap: boolean;
}) => {
  const code = keyedLine.tokens.length === 0
    ? "\u00a0"
    : keyedLine.tokens.map(({ token, key }) => (
        <TokenSpan key={key} token={token} />
      ));

  if (!showLineNumbers) {
    return <span className="block min-h-5">{code}</span>;
  }

  return (
    <span className={cn("flex min-h-5 items-start", wrap ? "min-w-0" : "min-w-max")}>
      <span className="mr-4 w-8 shrink-0 select-none text-right font-mono text-muted-foreground/50">
        {lineNumber}
      </span>
      <span className={cn("block", wrap ? "min-w-0 flex-1" : "min-w-max")}>
        {code}
      </span>
    </span>
  );
};

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  showGlance?: boolean;
  showRenderToggle?: boolean;
  showWrapToggle?: boolean;
  defaultWrap?: boolean;
  fillHeight?: boolean;
  loadingMore?: boolean;
  onReachEnd?: () => void;
  startLineNumber?: number;
  maxHighlightChars?: number;
};

interface CodeViewport {
  top: number;
  height: number;
}

type CodeViewMode = "source" | "render";

interface GlanceRow {
  key: string;
  tokens: KeyedToken[];
}

interface GlanceSegment {
  key: string;
  token: ThemedToken;
  left: number;
  width: number;
}

interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

interface AsyncTokenizedCode {
  key: string;
  result: TokenizedCode;
}

interface CodeBlockContextType {
  code: string;
}

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();

const tokensCache = new Map<string, TokenizedCode>();

const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

const getTokensCacheKey = (code: string, language: BundledLanguage) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${language}:${code.length}:${start}:${end}`;
};

const getHighlighter = (
  language: BundledLanguage
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const cached = highlighterCache.get(language);
  if (cached) {
    return cached;
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: ["github-light", "github-dark"],
  });

  highlighterCache.set(language, highlighterPromise);
  return highlighterPromise;
};

const createRawTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ]
  ),
});

export const highlightCode = (
  code: string,
  language: BundledLanguage,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void
): TokenizedCode | null => {
  const tokensCacheKey = getTokensCacheKey(code, language);

  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    return cached;
  }

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  // 高亮器异步加载，先返回朴素 token，加载完成后通知订阅者刷新。
  getHighlighter(language)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(language) ? language : "text";

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: {
          dark: "github-dark",
          light: "github-light",
        },
      });

      const tokenized: TokenizedCode = {
        bg: result.bg ?? "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      tokensCache.set(tokensCacheKey, tokenized);

      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
        subscribers.delete(tokensCacheKey);
      }
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      console.error("Failed to highlight code:", error);
      subscribers.delete(tokensCacheKey);
    });

  return null;
};

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    startLineNumber,
    wrap,
    className,
  }: {
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    startLineNumber: number;
    wrap: boolean;
    className?: string;
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg]
    );

    const keyedLines = useMemo(
      () => addKeysToTokens(tokenized.tokens),
      [tokenized.tokens]
    );

    return (
      <pre
        className={cn(
          "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)] m-0 p-4 text-sm leading-5",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          className
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono text-sm"
          )}
        >
          {keyedLines.map((keyedLine, index) => (
            <LineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              lineNumber={startLineNumber + index}
              showLineNumbers={showLineNumbers}
              wrap={wrap}
            />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.startLineNumber === nextProps.startLineNumber &&
    prevProps.wrap === nextProps.wrap &&
    prevProps.className === nextProps.className
);

CodeBlockBody.displayName = "CodeBlockBody";

export const CodeBlockContainer = ({
  className,
  fillHeight = false,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { fillHeight?: boolean; language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
      className
    )}
    data-language={language}
    style={{
      containIntrinsicSize: fillHeight ? undefined : "auto 200px",
      contentVisibility: fillHeight ? undefined : "auto",
      ...style,
    }}
    {...props}
  />
);

export const CodeBlockHeader = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-center justify-between border-b bg-muted/80 px-3 py-2 text-muted-foreground text-xs",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
);

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("-my-1 -mr-1 flex items-center gap-2", className)}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
  startLineNumber = 1,
  showGlance = false,
  wrap = false,
  maxHighlightChars = 120_000,
  scroll = true,
  fillHeight = false,
  loadingMore = false,
  onReachEnd,
  className,
  bodyClassName,
}: {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  startLineNumber?: number;
  showGlance?: boolean;
  wrap?: boolean;
  maxHighlightChars?: number;
  scroll?: boolean;
  fillHeight?: boolean;
  loadingMore?: boolean;
  onReachEnd?: () => void;
  className?: string;
  bodyClassName?: string;
}) => {
  const shouldHighlight = code.length <= maxHighlightChars;
  const tokensCacheKey = useMemo(() => getTokensCacheKey(code, language), [code, language]);
  // 高亮未完成前先展示原始 token，避免空白闪烁。
  const rawTokens = useMemo(() => createRawTokens(code), [code]);

  // 同步读取缓存，命中时不再等 effect 触发刷新。
  const syncTokens = useMemo(
    () => shouldHighlight ? highlightCode(code, language) ?? rawTokens : rawTokens,
    [code, language, rawTokens, shouldHighlight]
  );

  // 异步高亮结果必须带上当前内容 key，避免旧 token 覆盖新代码。
  const [asyncTokens, setAsyncTokens] = useState<AsyncTokenizedCode | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!shouldHighlight) return undefined;

    highlightCode(code, language, (result) => {
      if (!cancelled) {
        setAsyncTokens({ key: tokensCacheKey, result });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, language, shouldHighlight, tokensCacheKey]);

  const tokenized = shouldHighlight && asyncTokens?.key === tokensCacheKey ? asyncTokens.result : syncTokens;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reachedEndRef = useRef(false);
  const [viewport, setViewport] = useState<CodeViewport>({ top: 0, height: 1 });
  const [contentWidth, setContentWidth] = useState(0);

  const syncViewport = useCallback((triggerReachEnd = false) => {
    const node = scrollRef.current;
    if (!node) return;
    const scrollable = Math.max(1, node.scrollHeight - node.clientHeight);
    setViewport({
      top: node.scrollTop / scrollable,
      height: Math.min(1, node.clientHeight / Math.max(1, node.scrollHeight)),
    });
    setContentWidth(node.clientWidth);

    const distanceToEnd = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (triggerReachEnd && onReachEnd && scroll && distanceToEnd < 120) {
      if (!reachedEndRef.current) {
        reachedEndRef.current = true;
        onReachEnd();
      }
    } else if (distanceToEnd > 240) {
      reachedEndRef.current = false;
    }
  }, [onReachEnd, scroll]);

  useEffect(() => {
    reachedEndRef.current = false;
  }, [code]);

  useLayoutEffect(() => {
    syncViewport(false);
  }, [syncViewport, code, wrap, tokenized]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;

    const resizeObserver = new ResizeObserver(() => syncViewport(false));
    resizeObserver.observe(node);
    resizeObserver.observe(node.firstElementChild ?? node);
    return () => {
      resizeObserver.disconnect();
    };
  }, [syncViewport]);

  return (
    <div className={cn("relative flex min-w-0 overflow-hidden", fillHeight && "min-h-0 flex-1", className)}>
      <div
        ref={scrollRef}
        onScroll={() => syncViewport(true)}
        className={cn(
          scroll
            ? cn("scrollbar-thin min-w-0 flex-1 overflow-auto", fillHeight ? "h-full max-h-none" : "max-h-[60vh]")
            : "min-w-max flex-1 overflow-visible"
        )}
      >
        <CodeBlockBody
          showLineNumbers={showLineNumbers}
          startLineNumber={startLineNumber}
          tokenized={tokenized}
          wrap={wrap}
          className={bodyClassName}
        />
        {loadingMore && (
          <div className="border-t bg-background/95 px-3 py-2 text-center text-xs text-muted-foreground">
            正在继续加载…
          </div>
        )}
      </div>
      {showGlance && (
        <CodeBlockGlance
          contentWidth={contentWidth}
          scrollRef={scrollRef}
          tokenized={tokenized}
          viewport={viewport}
          wrap={wrap}
        />
      )}
    </div>
  );
};

function splitWrappedGlanceRows(lines: KeyedLine[], wrap: boolean, contentWidth: number): GlanceRow[] {
  if (!wrap) return lines;
  const charsPerRow = Math.max(24, Math.floor((contentWidth - 64) / 7.4));
  const rows: GlanceRow[] = [];

  for (const line of lines) {
    const tokens = line.tokens.filter(({ token }) => token.content.length > 0);
    if (tokens.length === 0) {
      rows.push({ key: line.key, tokens: [] });
      continue;
    }

    let current: KeyedToken[] = [];
    let currentLength = 0;
    let rowIndex = 0;

    for (const keyed of tokens) {
      const pieces = keyed.token.content.split(/(\s+)/);
      for (const piece of pieces) {
        if (!piece) continue;
        if (currentLength > 0 && currentLength + piece.length > charsPerRow) {
          rows.push({ key: `${line.key}-wrap-${rowIndex}`, tokens: current });
          current = [];
          currentLength = 0;
          rowIndex += 1;
        }
        current.push({
          key: `${keyed.key}-${rowIndex}-${current.length}`,
          token: { ...keyed.token, content: piece },
        });
        currentLength += piece.length;
      }
    }

    rows.push({ key: `${line.key}-wrap-${rowIndex}`, tokens: current });
  }

  return rows;
}

function sampleGlanceRows(rows: GlanceRow[], limit: number): GlanceRow[] {
  if (rows.length <= limit) return rows;
  return Array.from({ length: limit }, (_, index) => rows[Math.floor(index * rows.length / limit)]);
}

const GLANCE_ROW_HEIGHT = 3;
const GLANCE_MAX_ROWS = 1600;
const GLANCE_MIN_COLUMNS = 80;
const GLANCE_MAX_COLUMNS = 180;

function glanceLineLength(row: GlanceRow): number {
  return row.tokens.reduce((length, { token }) => length + token.content.length, 0);
}

function glanceSegments(row: GlanceRow, columns: number): GlanceSegment[] {
  const segments: GlanceSegment[] = [];
  let offset = 0;

  for (const { token, key } of row.tokens) {
    const content = token.content;
    const pattern = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      const start = offset + match.index;
      if (start >= columns) continue;
      const width = Math.min(match[0].length, columns - start);
      segments.push({
        key: `${key}-${match.index}`,
        token,
        left: start / columns,
        width: Math.max(1 / columns, width / columns),
      });
    }
    offset += content.length;
  }

  return segments;
}

function CodeBlockGlance({
  contentWidth,
  scrollRef,
  tokenized,
  viewport,
  wrap,
}: {
  contentWidth: number;
  scrollRef: RefObject<HTMLDivElement>;
  tokenized: TokenizedCode;
  viewport: CodeViewport;
  wrap: boolean;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const keyedLines = useMemo(() => addKeysToTokens(tokenized.tokens), [tokenized.tokens]);
  const glanceRows = useMemo(
    () => splitWrappedGlanceRows(keyedLines, wrap, contentWidth),
    [contentWidth, keyedLines, wrap]
  );
  const visibleLines = useMemo(
    () => sampleGlanceRows(glanceRows, GLANCE_MAX_ROWS),
    [glanceRows]
  );
  const columns = useMemo(() => {
    const longestLine = glanceRows.reduce((max, row) => Math.max(max, glanceLineLength(row)), 0);
    return Math.max(GLANCE_MIN_COLUMNS, Math.min(GLANCE_MAX_COLUMNS, longestLine || GLANCE_MIN_COLUMNS));
  }, [glanceRows]);
  const mapHeight = visibleLines.length * GLANCE_ROW_HEIGHT + 8;
  // 缩略图比容器高时移动预览内容；否则滑块只在真实预览高度内移动。
  const mapScrollable = Math.max(0, mapHeight - trackHeight);
  const mapScrollTop = mapScrollable > 0 ? viewport.top * mapScrollable : 0;
  const sliderTrackHeight = trackHeight <= 0 ? 0 : mapScrollable > 0 ? trackHeight : Math.min(trackHeight, mapHeight);
  const sliderHeightPx = trackHeight <= 0
    ? 0
    : mapScrollable > 0
      ? Math.max(8, Math.min(trackHeight, viewport.height * mapHeight))
      : Math.max(8, Math.min(sliderTrackHeight, viewport.height * sliderTrackHeight));
  const sliderTopPx = sliderTrackHeight <= sliderHeightPx ? 0 : viewport.top * (sliderTrackHeight - sliderHeightPx);

  useLayoutEffect(() => {
    const node = trackRef.current;
    if (!node) return undefined;
    const update = () => setTrackHeight(node.clientHeight);
    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, []);

  const scrollToPointer = useCallback((clientY: number, target: HTMLDivElement) => {
    const node = scrollRef.current;
    if (!node) return;
    const scrollable = Math.max(0, node.scrollHeight - node.clientHeight);
    if (scrollable <= 0) return;
    const rect = target.getBoundingClientRect();
    const y = Math.max(0, Math.min(sliderTrackHeight, clientY - rect.top));
    if (mapScrollable > 0) {
      const mapY = mapScrollTop + y;
      const targetTop = Math.max(0, Math.min(1, (mapY - sliderHeightPx / 2) / Math.max(1, mapHeight - sliderHeightPx)));
      node.scrollTop = targetTop * scrollable;
      return;
    }
    const targetTop = Math.max(0, Math.min(1, (y - sliderHeightPx / 2) / Math.max(1, sliderTrackHeight - sliderHeightPx)));
    node.scrollTop = targetTop * scrollable;
  }, [mapHeight, mapScrollTop, mapScrollable, scrollRef, sliderHeightPx, sliderTrackHeight]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const track = event.currentTarget;
    track.setPointerCapture?.(event.pointerId);
    scrollToPointer(event.clientY, track);
    const onMove = (moveEvent: PointerEvent) => scrollToPointer(moveEvent.clientY, track);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [scrollToPointer]);

  const startThumbDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const node = scrollRef.current;
    const track = trackRef.current;
    if (!node || !track) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const scrollable = Math.max(0, node.scrollHeight - node.clientHeight);
    const startY = event.clientY;
    const startScrollTop = node.scrollTop;
    const dragRange = Math.max(1, sliderTrackHeight - sliderHeightPx);

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientY - startY;
      node.scrollTop = Math.max(0, Math.min(scrollable, startScrollTop + delta / dragRange * scrollable));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [scrollRef, sliderHeightPx, sliderTrackHeight]);

  return (
    <div className="hidden max-h-full w-14 shrink-0 overflow-hidden border-l bg-background/95 px-1.5 py-2 sm:block">
      <div
        ref={trackRef}
        className="relative h-full min-h-0 cursor-pointer touch-none select-none overflow-hidden rounded-sm bg-muted/40 py-1"
        onPointerDown={startDrag}
        role="scrollbar"
        aria-label="代码缩略图滚动条"
        aria-orientation="vertical"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(viewport.top * 100)}
      >
        <div className="absolute inset-x-0 top-1 space-y-px" style={{ transform: `translateY(${-mapScrollTop}px)` }}>
          {visibleLines.map((line) => {
            const segments = glanceSegments(line, columns);
            return (
              <div key={line.key} className="relative mx-1 h-[2px]">
                {segments.map(({ token, key, left, width }) => (
                  <span
                    key={key}
                    className="dark:!bg-[var(--shiki-dark)] absolute h-full rounded-full"
                    style={{
                      backgroundColor: token.color ?? "currentColor",
                      left: `${left * 100}%`,
                      opacity: token.color ? 0.9 : 0.25,
                      width: `max(1px, ${width * 100}%)`,
                      ...token.htmlStyle,
                    } as CSSProperties}
                  />
                ))}
              </div>
            );
          })}
        </div>
        <div
          className="absolute left-0 right-0 cursor-grab rounded-sm border border-primary/70 bg-primary/15 shadow-[inset_0_0_0_1px_hsl(var(--background)/0.65)] active:cursor-grabbing"
          onPointerDown={startThumbDrag}
          style={{ top: sliderTopPx, height: sliderHeightPx }}
        />
      </div>
    </div>
  );
}

function isRenderableLanguage(language: BundledLanguage): boolean {
  return ["markdown", "md", "csv"].includes(String(language));
}

function parseCsvRows(code: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) rows.push(row);
  return rows;
}

function CsvPreview({ code, fillHeight }: { code: string; fillHeight: boolean }) {
  const rows = useMemo(() => parseCsvRows(code), [code]);
  const [head, ...body] = rows;
  const columnCount = Math.max(...rows.map((row) => row.length), 1);

  return (
    <div className={cn("scrollbar-thin overflow-auto p-3", fillHeight ? "min-h-0 flex-1" : "max-h-[60vh]")}>
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-background">
          <tr>
            {Array.from({ length: columnCount }).map((_, index) => (
              <th key={index} className="border-b px-2 py-1.5 font-medium text-muted-foreground">
                {head?.[index] ?? `列 ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, 500).map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-0">
              {Array.from({ length: columnCount }).map((_, columnIndex) => (
                <td key={columnIndex} className="max-w-72 whitespace-pre-wrap break-words px-2 py-1.5 align-top">
                  {row[columnIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > 500 && (
        <div className="px-2 py-2 text-xs text-muted-foreground">
          仅预览前 500 行
        </div>
      )}
    </div>
  );
}

class RenderErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("代码渲染视图失败:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-4 text-sm text-destructive">
          渲染失败，已保留源码视图可继续查看。
        </div>
      );
    }
    return this.props.children;
  }
}

function CodeBlockRenderedContent({
  code,
  fillHeight,
  language,
}: {
  code: string;
  fillHeight: boolean;
  language: BundledLanguage;
}) {
  if (String(language) === "csv") {
    return <CsvPreview code={code} fillHeight={fillHeight} />;
  }

  return (
    <div className={cn("scrollbar-thin overflow-auto p-4", fillHeight ? "min-h-0 flex-1" : "max-h-[60vh]")}>
      <RenderErrorBoundary key={`${language}:${code.length}:${code.slice(0, 48)}`}>
        <MarkdownContent plugins={streamdownPreviewPlugins} text={code} />
      </RenderErrorBoundary>
    </div>
  );
}

export const CodeBlock = memo(({
  code,
  language,
  showLineNumbers = false,
  showGlance = false,
  showRenderToggle = true,
  showWrapToggle = false,
  defaultWrap = false,
  fillHeight = false,
  loadingMore = false,
  onReachEnd,
  startLineNumber = 1,
  maxHighlightChars = 120_000,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code]);
  const [wrap, setWrap] = useState(defaultWrap);
  const [viewMode, setViewMode] = useState<CodeViewMode>("source");
  const [glanceOpen, setGlanceOpen] = useState(showGlance);
  const canRender = showRenderToggle && isRenderableLanguage(language);
  const showDefaultHeader = showGlance || showWrapToggle || canRender;

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer
        className={cn(fillHeight && "flex h-full min-h-0 flex-col", className)}
        fillHeight={fillHeight}
        language={language}
        {...props}
      >
        {children}
        {showDefaultHeader && (
          <CodeBlockHeader>
            <CodeBlockTitle>
              <CodeBlockFilename>{language}</CodeBlockFilename>
            </CodeBlockTitle>
            <CodeBlockActions>
              {canRender && (
                <div className="flex items-center rounded-md border bg-background p-0.5">
                  <Button
                    type="button"
                    variant={viewMode === "source" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setViewMode("source")}
                    title="查看源码"
                  >
                    <Code2Icon className="size-3.5" />
                    源码
                  </Button>
                  <Button
                    type="button"
                    variant={viewMode === "render" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setViewMode("render")}
                    title="查看渲染结果"
                  >
                    <EyeIcon className="size-3.5" />
                    渲染
                  </Button>
                </div>
              )}
              {showGlance && (
                <Button
                  type="button"
                  variant={glanceOpen ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setGlanceOpen((value) => !value)}
                  title={glanceOpen ? "关闭代码缩略图" : "打开代码缩略图"}
                >
                  <MapIcon className="size-3.5" />
                  缩略图
                </Button>
              )}
              {showWrapToggle && (
                <Button
                  type="button"
                  variant={wrap ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setWrap((value) => !value)}
                  title={wrap ? "关闭自动换行" : "开启自动换行"}
                >
                  <AlignLeftIcon className="size-3.5" />
                  {wrap ? "换行" : "不换行"}
                </Button>
              )}
              <CodeBlockCopyButton className="size-7" />
            </CodeBlockActions>
          </CodeBlockHeader>
        )}
        {viewMode === "render" && canRender ? (
          <CodeBlockRenderedContent code={code} fillHeight={fillHeight} language={language} />
        ) : (
          <CodeBlockContent
            code={code}
            fillHeight={fillHeight}
            language={language}
            loadingMore={loadingMore}
            onReachEnd={onReachEnd}
            showLineNumbers={showLineNumbers}
            startLineNumber={startLineNumber}
            showGlance={showGlance && glanceOpen}
            wrap={wrap}
            maxHighlightChars={maxHighlightChars}
          />
        )}
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
});

CodeBlock.displayName = "CodeBlock";

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout
        );
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (
  props: CodeBlockLanguageSelectorProps
) => <Select {...props} />;

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<
  typeof SelectTrigger
>;

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn(
      "h-7 border-none bg-transparent px-2 text-xs shadow-none",
      className
    )}
    size="sm"
    {...props}
  />
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<
  typeof SelectValue
>;

export const CodeBlockLanguageSelectorValue = (
  props: CodeBlockLanguageSelectorValueProps
) => <SelectValue {...props} />;

export type CodeBlockLanguageSelectorContentProps = ComponentProps<
  typeof SelectContent
>;

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => (
  <SelectContent align={align} {...props} />
);

export type CodeBlockLanguageSelectorItemProps = ComponentProps<
  typeof SelectItem
>;

export const CodeBlockLanguageSelectorItem = (
  props: CodeBlockLanguageSelectorItemProps
) => <SelectItem {...props} />;
