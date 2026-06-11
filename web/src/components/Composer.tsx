import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';

interface Props {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function Composer({ disabled, onSend }: Props) {
  function handleSubmit(message: PromptInputMessage) {
    const text = message.text?.trim();
    if (!text || disabled) return;
    onSend(text);
  }

  return (
    <div className="bg-card px-6 py-4">
      <div className="mx-auto max-w-3xl">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="描述一个任务…（Enter 发送，Shift+Enter 换行）" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit status={disabled ? 'submitted' : undefined} disabled={disabled} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
