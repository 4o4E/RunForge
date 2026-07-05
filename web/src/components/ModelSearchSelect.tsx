import { useState, type ComponentProps } from 'react';
import { Bot, Check, ChevronsUpDown } from 'lucide-react';
import type { LlmModelOption, LlmSettings } from '@/api';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function llmModelRef(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

export function llmOptionsFromSettings(settings: LlmSettings): LlmModelOption[] {
  return settings.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      ref: llmModelRef(provider.id, model),
      providerId: provider.id,
      providerLabel: provider.label || provider.id,
      provider: provider.provider,
      model,
      label: `${provider.label || provider.id} · ${model}`,
    })),
  );
}

export function ModelSearchSelect({
  value,
  options,
  onChange,
  placeholder = '选择模型',
  disabled = false,
  variant = 'outline',
  className,
  compact = false,
  focusSearchOnOpen = true,
}: {
  value: string;
  options: LlmModelOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  variant?: ComponentProps<typeof Button>['variant'];
  className?: string;
  compact?: boolean;
  focusSearchOnOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.ref === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={variant}
          className={cn('h-10 w-full justify-between gap-2', className)}
          aria-expanded={open}
          disabled={disabled || options.length === 0}
          title={selected ? `当前模型：${selected.label}` : value || placeholder}
        >
          <Bot className="h-4 w-4 shrink-0 opacity-70" />
          {!compact && <span className="min-w-0 flex-1 truncate text-left">{selected ? selected.label : value || placeholder}</span>}
          {!compact && <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-max min-w-[--radix-popover-trigger-width] p-0"
        onOpenAutoFocus={(event) => {
          if (!focusSearchOnOpen) event.preventDefault();
        }}
      >
        <Command>
          <CommandInput placeholder="搜索供应商或模型" />
          <CommandList>
            <CommandEmpty>没有匹配的模型</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.ref}
                  value={`${option.providerLabel} ${option.providerId} ${option.provider} ${option.model} ${option.ref}`}
                  onSelect={() => {
                    onChange(option.ref);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('h-4 w-4', option.ref === value ? 'opacity-100' : 'opacity-0')} />
                  <div className="min-w-max">
                    <div className="whitespace-nowrap text-sm font-medium">{option.model}</div>
                    <div className="whitespace-nowrap text-xs text-muted-foreground">{option.providerLabel} · {option.ref}</div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
