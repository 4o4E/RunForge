import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeCtx } from '../theme';

export function CodeBlock({ language, value }: { language: string; value: string }) {
  const { theme } = useThemeCtx();
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-surface-400">
      <div className="flex items-center justify-between border-b border-surface-400 bg-surface-300 px-3 py-1 text-[11px] text-surface-800">
        <span className="font-mono lowercase">{language || 'text'}</span>
        <div className="flex items-center gap-3">
          <button onClick={() => setWrap((w) => !w)} className="transition hover:text-surface-950">
            {wrap ? '不换行' : '自动换行'}
          </button>
          <button onClick={copy} className="transition hover:text-surface-950">
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={theme === 'dark' ? oneDark : oneLight}
        showLineNumbers
        wrapLongLines={wrap}
        customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', maxHeight: '70vh', overflow: 'auto' }}
        codeTagProps={{ style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}
