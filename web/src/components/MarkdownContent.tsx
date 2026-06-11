import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

const components: Components = {
  // Unwrap <pre> so fenced blocks are fully controlled by the code renderer below.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const match = /language-(\w+)/.exec(className || '');
    const isBlock = Boolean(match) || text.includes('\n');
    if (!isBlock) return <code className={className}>{children}</code>;
    return <CodeBlock language={match?.[1] ?? 'text'} value={text.replace(/\n$/, '')} />;
  },
};

/** Renders Markdown (GFM) with theme-aware styling; code blocks get highlighting. */
export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
