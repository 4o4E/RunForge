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
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

// 工具调用和思考块保持同一层级：单行触发器 + 柔和展开内容。
export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group/tool not-prose mb-2 w-full", className)}
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
        "flex w-full items-center gap-2 text-left text-muted-foreground text-sm transition-colors hover:text-foreground",
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
      "mt-2 space-y-2 text-muted-foreground text-sm",
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

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

function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">[]</span>;
    return (
      <div className="space-y-1">
        {value.map((item, index) => (
          <div key={index} className="grid min-w-0 grid-cols-[2rem,1fr] gap-2">
            <span className="select-none text-right text-muted-foreground">{index}</span>
            <JsonValue value={item} depth={depth + 1} />
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
          <div key={key} className="grid min-w-0 grid-cols-[minmax(7rem,14rem),1fr] gap-2">
            <span className="min-w-0 truncate font-medium text-muted-foreground" title={key}>
              {key}
            </span>
            <div className="min-w-0">
              <JsonValue value={item} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    );
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

function JsonPanel({ value }: { value: unknown }) {
  return (
    <div className="scrollbar-thin max-h-[44vh] overflow-auto rounded-md border bg-background p-2 text-xs text-foreground">
      <JsonValue value={value as JsonLike} />
    </div>
  );
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-1 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs">
      参数
    </h4>
    <JsonPanel value={input ?? {}} />
  </div>
);

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
        <CodeBlock code={output} language="log" showGlance showWrapToggle />
      );
  }

  return (
    <div className={cn("space-y-1", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs">
        {errorText ? "错误" : "结果"}
      </h4>
      {/* 输出在视口内滚动，避免长结果把整段对话撑得过高。 */}
      <div
        className={cn(
          "max-h-[60vh] overflow-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/35 text-foreground"
        )}
      >
        {errorText && <div className="p-2">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
