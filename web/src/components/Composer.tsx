import { useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

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
    <div className="border-t bg-card px-6 py-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="描述一个任务…（Enter 发送，Shift+Enter 换行）"
          disabled={disabled}
          className="max-h-40 min-h-[44px] flex-1 resize-none bg-background"
        />
        <Button onClick={send} disabled={disabled || !input.trim()} size="icon" className="h-11 w-11 shrink-0">
          <SendHorizontal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
