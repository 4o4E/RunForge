"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  FileTextIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import type { BundledLanguage } from "shiki";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

// 工具调用和思考块保持同一层级：单行触发器 + 柔和展开内容。
export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group/tool not-prose w-full", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
  duration?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "等待确认",
  "approval-responded": "已确认",
  "input-available": "调用中",
  "input-streaming": "准备中",
  "output-available": "",
  "output-denied": "已拒绝",
  "output-error": "调用失败",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-3.5 text-muted-foreground" />,
  "approval-responded": <CheckCircleIcon className="size-3.5 text-muted-foreground" />,
  "input-available": <ClockIcon className="size-3.5 animate-pulse text-muted-foreground" />,
  "input-streaming": <CircleIcon className="size-3.5 text-muted-foreground" />,
  "output-available": null,
  "output-denied": <XCircleIcon className="size-3.5 text-muted-foreground" />,
  "output-error": <XCircleIcon className="size-3.5 text-destructive" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
    {statusIcons[status]}
    {statusLabels[status]}
  </span>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  duration,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex h-6 w-full items-center gap-2 text-left text-muted-foreground text-sm transition-colors hover:text-foreground",
        className
      )}
      {...props}
    >
      <WrenchIcon className="size-4 shrink-0" />
      <span className="min-w-0 truncate">
        调用 <span className="text-foreground">{title ?? derivedName}</span>
      </span>
      {statusLabels[state] && (
        <span className="flex shrink-0 items-center gap-1 text-xs">
          {statusIcons[state]}
          {statusLabels[state]}
        </span>
      )}
      {duration && <span className="shrink-0 text-xs text-muted-foreground">{duration}</span>}
      <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]/tool:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "mt-1 space-y-2 text-muted-foreground text-sm",
      "outline-none",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
  toolName?: string;
  workspaceRoot?: string | null;
  onOpenRemoteFile?: (path: string) => void;
};

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };
type ToolCodeInput = {
  code: string;
  key: string;
  language: BundledLanguage;
  showLineNumbers: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isValidElement(value);
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function scalarLabel(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function stripPathLineSuffix(value: string): string {
  return value.trim().replace(/(?::\d+){1,2}$/, "");
}

function isPathKey(key?: string): boolean {
  return !!key && /(^|_)(path|file|filename|target|source|cwd|dir|directory)(_|$)/i.test(key);
}

function isFilePathCandidate(value: string, key?: string, workspaceRoot?: string | null): boolean {
  const path = stripPathLineSuffix(value);
  if (!path || path.length > 500) return false;
  if (workspaceRoot && path.startsWith(`${workspaceRoot.replace(/\/+$/, "")}/`)) return true;
  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) return path.includes("/");
  if (isPathKey(key)) return path.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(path);
  return /^(server|web|docs|src|uploads|tests)\//.test(path);
}

function FilePathButton({ value, onOpenRemoteFile }: { value: string; onOpenRemoteFile: (path: string) => void }) {
  const path = stripPathLineSuffix(value);
  return (
    <button
      type="button"
      onClick={() => onOpenRemoteFile(path)}
      className="inline-flex max-w-full items-center gap-1 rounded-sm border bg-background px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
      title={path}
    >
      <FileTextIcon className="size-3 shrink-0" />
      <span className="truncate">{value}</span>
    </button>
  );
}

function JsonValue({
  value,
  depth = 0,
  objectKey,
  workspaceRoot,
  onOpenRemoteFile,
}: {
  value: unknown;
  depth?: number;
  objectKey?: string;
  workspaceRoot?: string | null;
  onOpenRemoteFile?: (path: string) => void;
}) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">[]</span>;
    return (
      <div className="space-y-1">
        {value.map((item, index) => (
          <div key={index} className="grid min-w-0 grid-cols-[2rem,minmax(0,1fr)] gap-2">
            <span className="select-none text-right text-muted-foreground">{index}</span>
            <JsonValue value={item} depth={depth + 1} objectKey={objectKey} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
          </div>
        ))}
      </div>
    );
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-muted-foreground">{'{}'}</span>;
    return (
      <div className={cn("space-y-1", depth > 0 && "rounded-md border border-border/50 p-2")}>
        {entries.map(([key, item]) => (
          <div key={key} className="grid min-w-0 grid-cols-[minmax(4.5rem,8rem),minmax(0,1fr)] gap-2">
            <span className="min-w-0 truncate font-medium text-muted-foreground" title={key}>
              {key}
            </span>
            <div className="min-w-0">
              <JsonValue value={item} depth={depth + 1} objectKey={key} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "string" && onOpenRemoteFile && isFilePathCandidate(value, objectKey, workspaceRoot)) {
    return <FilePathButton value={value} onOpenRemoteFile={onOpenRemoteFile} />;
  }

  return (
    <span
      className={cn(
        "break-words rounded-sm px-1 py-0.5 font-mono text-xs",
        typeof value === "string" ? "bg-background" : "bg-muted text-muted-foreground"
      )}
    >
      {scalarLabel(value)}
    </span>
  );
}

function JsonPanel({
  value,
  workspaceRoot,
  onOpenRemoteFile,
}: {
  value: unknown;
  workspaceRoot?: string | null;
  onOpenRemoteFile?: (path: string) => void;
}) {
  return (
    <div className="scrollbar-thin max-h-[44vh] overflow-auto rounded-md border bg-background p-2 text-xs text-foreground">
      <JsonValue value={value as JsonLike} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
    </div>
  );
}

function inputObject(input: unknown): Record<string, unknown> | null {
  if (isPlainObject(input)) return input;
  if (typeof input !== "string") return null;
  const parsed = tryParseJson(input);
  return isPlainObject(parsed) ? parsed : null;
}

function languageFromPath(path: unknown): BundledLanguage {
  if (typeof path !== "string") return "log";
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const languageByExtension: Record<string, BundledLanguage> = {
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    py: "python",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    yaml: "yaml",
    yml: "yaml",
  };
  return languageByExtension[extension] ?? "log";
}

function codeInputForTool(toolName: string | undefined, value: Record<string, unknown>): ToolCodeInput | null {
  // 大段正文参数要按代码块渲染，避免 JSON 行内展示吞掉换行。
  if (toolName === "shell" && typeof value.command === "string") {
    return {
      code: value.command,
      key: "command",
      language: "bash",
      showLineNumbers: true,
    };
  }

  if (toolName === "file_write" && typeof value.content === "string") {
    return {
      code: value.content,
      key: "content",
      language: languageFromPath(value.path),
      showLineNumbers: true,
    };
  }

  return null;
}

function ToolInputTable({
  entries,
  workspaceRoot,
  onOpenRemoteFile,
}: {
  entries: Array<[string, unknown]>;
  workspaceRoot?: string | null;
  onOpenRemoteFile?: (path: string) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <table className="w-full border-collapse text-left text-xs">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-b last:border-0">
              <th className="w-32 max-w-40 bg-muted/45 px-2 py-1.5 align-top font-medium text-muted-foreground">
                <span className="block truncate" title={key}>{key}</span>
              </th>
              <td className="min-w-0 px-2 py-1.5 align-top text-foreground">
                <JsonValue value={value} objectKey={key} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolCodeInputView({
  input,
  codeInput,
  workspaceRoot,
  onOpenRemoteFile,
}: {
  input: Record<string, unknown>;
  codeInput: ToolCodeInput;
  workspaceRoot?: string | null;
  onOpenRemoteFile?: (path: string) => void;
}) {
  const tableEntries = Object.entries(input).filter(([key]) => key !== codeInput.key);

  return (
    <div className="space-y-2">
      <ToolInputTable entries={tableEntries} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
      <div className="rounded-md bg-muted/35 text-xs text-foreground">
        <CodeBlock
          code={codeInput.code}
          language={codeInput.language}
          showGlance
          showLineNumbers={codeInput.showLineNumbers}
          showWrapToggle
        />
      </div>
    </div>
  );
}

export const ToolInput = ({ className, input, toolName, workspaceRoot, onOpenRemoteFile, ...props }: ToolInputProps) => {
  const objectInput = inputObject(input);
  const codeInput = objectInput ? codeInputForTool(toolName, objectInput) : null;

  return (
    <div className={cn("space-y-1 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs">
        参数
      </h4>
      {objectInput && codeInput ? (
        <ToolCodeInputView input={objectInput} codeInput={codeInput} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
      ) : (
        <JsonPanel value={input ?? {}} workspaceRoot={workspaceRoot} onOpenRemoteFile={onOpenRemoteFile} />
      )}
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = <JsonPanel value={output} />;
  } else if (typeof output === "string") {
    const parsed = tryParseJson(output);
    Output =
      parsed && (Array.isArray(parsed) || isPlainObject(parsed)) ? (
        <JsonPanel value={parsed} />
      ) : (
        <CodeBlock code={output} language="log" showGlance showLineNumbers showWrapToggle />
      );
  }

  return (
    <div className={cn("space-y-1", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs">
        {errorText ? "错误" : "结果"}
      </h4>
      <div
        className={cn(
          "rounded-md text-xs [&_table]:w-full",
          errorText
            ? "max-h-[60vh] overflow-auto bg-destructive/10 text-destructive"
            : "bg-muted/35 text-foreground"
        )}
      >
        {errorText && <div className="p-2">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
