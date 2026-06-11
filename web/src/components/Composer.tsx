import { useState } from 'react';

interface Props {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled, onSend }: Props) {
  const [input, setInput] = useState('');

  function send() {
    const text = input.trim();
    if (!text || disabled) return;
    setInput('');
    onSend(text);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="border-t border-surface-500 bg-surface-100 px-6 py-4">
      <div className="mx-auto flex max-w-3xl items-end gap-3 rounded-2xl border border-surface-500 bg-surface-50 px-3 py-2 shadow-sm focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-100">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="描述一个任务…（Enter 发送，Shift+Enter 换行）"
          disabled={disabled}
          className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed text-surface-950 outline-none placeholder:text-surface-700 disabled:opacity-60"
        />
        <button
          onClick={send}
          disabled={disabled || !input.trim()}
          className="mb-0.5 shrink-0 rounded-xl bg-primary-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-primary-600 disabled:cursor-not-allowed disabled:bg-surface-600"
        >
          {disabled ? '运行中' : '发送'}
        </button>
      </div>
    </div>
  );
}
