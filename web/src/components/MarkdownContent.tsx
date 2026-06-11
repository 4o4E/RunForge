import { Streamdown } from 'streamdown';
import type { StreamdownProps } from 'streamdown';
import { cn } from '@/lib/utils';
import { streamdownPlugins, useThemedMermaid } from './streamdownConfig';

// Streamdown 统一负责流式 Markdown、代码高亮、表格、数学公式和 Mermaid 渲染。
export function MarkdownContent({
  text,
  className,
  components,
}: {
  text: string;
  className?: string;
  components?: StreamdownProps['components'];
}) {
  const mermaid = useThemedMermaid();

  return (
    <Streamdown
      className={cn(
        'markdown-content text-sm leading-relaxed text-foreground [&_pre]:my-2 [&_pre]:max-h-[70vh] [&_pre]:overflow-auto',
        className,
      )}
      components={components}
      mermaid={mermaid}
      parseIncompleteMarkdown
      plugins={streamdownPlugins}
      shikiTheme={['github-light', 'github-dark']}
    >
      {text}
    </Streamdown>
  );
}
