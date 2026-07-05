import { Streamdown } from 'streamdown';
import type { StreamdownProps } from 'streamdown';
import { cn } from '@/lib/utils';
import { MarkdownRenderOptionsProvider, markdownRemarkPlugins, markdownUrlTransform, useStreamdownComponents } from './streamdownComponents';
import { streamdownPlugins, useThemedMermaid } from './streamdownConfig';

// Streamdown 统一负责流式 Markdown、代码高亮、表格、数学公式和 Mermaid 渲染。
export function MarkdownContent({
  text,
  className,
  components,
  plugins = streamdownPlugins,
  streaming = false,
}: {
  text: string;
  className?: string;
  components?: StreamdownProps['components'];
  plugins?: StreamdownProps['plugins'];
  streaming?: boolean;
}) {
  const mermaid = useThemedMermaid();
  const mergedComponents = useStreamdownComponents(components);

  return (
    <MarkdownRenderOptionsProvider value={{ streaming }}>
      <Streamdown
        className={cn(
          'markdown-content text-sm leading-relaxed text-foreground [&_pre]:my-2 [&_pre]:max-h-[70vh] [&_pre]:overflow-auto',
          '[&_table]:mx-0 [&_table]:w-full max-sm:[&_td]:px-1.5 max-sm:[&_th]:px-1.5',
          className,
        )}
        components={mergedComponents}
        mermaid={mermaid}
        parseIncompleteMarkdown
        plugins={plugins}
        remarkPlugins={markdownRemarkPlugins}
        shikiTheme={['github-light', 'github-dark']}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </Streamdown>
    </MarkdownRenderOptionsProvider>
  );
}
