import type { UIMessage } from 'ai';
import { Conversation } from './Conversation';
import { Composer } from './Composer';
import { Badge } from '@/components/ui/badge';

interface Props {
  title: string;
  messages: UIMessage[];
  busy: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
}

export function ChatView({
  title,
  messages,
  busy,
  draft,
  onDraftChange,
  onSend,
}: Props) {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center border-b bg-card px-6">
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <Badge variant={busy ? 'default' : 'secondary'} className="ml-3">
          {busy ? '运行中' : '空闲'}
        </Badge>
      </header>

      <div className="min-h-0 flex-1">
        <Conversation messages={messages} busy={busy} />
      </div>

      <Composer disabled={busy} draft={draft} onDraftChange={onDraftChange} onSend={onSend} />
    </main>
  );
}
