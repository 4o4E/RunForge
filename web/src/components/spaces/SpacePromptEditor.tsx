import type { PromptPlaceholder } from '@runforge/contracts';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';

interface EditorProps {
  template: string;
  placeholders: PromptPlaceholder[];
  onTemplateChange: (template: string) => void;
}

export function SpacePromptEditor({ template, placeholders, onTemplateChange }: EditorProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-medium">可用占位符</span>
        <div
          className="scrollbar-thin flex min-w-0 flex-1 gap-1.5 overflow-x-auto overflow-y-hidden pb-1"
          onWheel={(event) => {
            const element = event.currentTarget;
            if (element.scrollWidth <= element.clientWidth) return;
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (!delta) return;
            const maxScroll = element.scrollWidth - element.clientWidth;
            const nextScroll = Math.max(0, Math.min(maxScroll, element.scrollLeft + delta));
            if (nextScroll === element.scrollLeft) return;
            event.preventDefault();
            element.scrollLeft = nextScroll;
          }}
        >
          {placeholders.map((placeholder) => (
            <Popover key={placeholder.key}>
              <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 font-mono text-xs">
                  {placeholder.token}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="grid w-96 max-w-[calc(100vw-2rem)] gap-3">
                <div className="grid gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{placeholder.label}</span>
                    {placeholder.runtime && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">运行时</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{placeholder.description}</div>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-xs">
                  {placeholder.content}
                </pre>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => void navigator.clipboard.writeText(placeholder.token)}
                >
                  <Copy className="size-4" />复制占位符
                </Button>
              </PopoverContent>
            </Popover>
          ))}
        </div>
      </div>
      <Textarea
        aria-label="提示词模板"
        className="h-full min-h-96 resize-none font-mono text-xs lg:min-h-0"
        value={template}
        onChange={(event) => onTemplateChange(event.target.value)}
      />
    </div>
  );
}
