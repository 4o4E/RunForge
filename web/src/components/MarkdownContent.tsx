import { Streamdown } from 'streamdown';
import type { StreamdownProps } from 'streamdown';
import { cn } from '@/lib/utils';
import { useStreamdownComponents } from './streamdownComponents';
import { streamdownPlugins, useThemedMermaid } from './streamdownConfig';

// Streamdown 统一负责流式 Markdown、代码高亮、表格、数学公式和 Mermaid 渲染。
export function MarkdownContent({
  text,
  className,
  components,
  plugins = streamdownPlugins,
}: {
  text: string;
  className?: string;
  components?: StreamdownProps['components'];
  plugins?: StreamdownProps['plugins'];
}) {
  const mermaid = useThemedMermaid();
  const mergedComponents = useStreamdownComponents(components);

  return (
    <Streamdown
      className={cn(
        'markdown-content text-sm leading-relaxed text-foreground [&_pre]:my-2 [&_pre]:max-h-[70vh] [&_pre]:overflow-auto',
        className,
      )}
      components={mergedComponents}
      mermaid={mermaid}
      parseIncompleteMarkdown
      plugins={plugins}
      shikiTheme={['github-light', 'github-dark']}
    >
      {text}
    </Streamdown>
  );
}
