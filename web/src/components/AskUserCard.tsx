import { Check, Circle, Plus, Sparkles, SquareCheckBig, X } from 'lucide-react';
import type { AskUserAnswer, AskUserOption, AskUserSpec } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface AskUserDraft {
  selectedIds: string[];
  customOptions: string[];
  pendingCustom: string;
  text: string;
  note: string;
}

export function emptyAskUserDraft(spec?: AskUserSpec): AskUserDraft {
  const recommended = spec ? recommendedOptions(spec).map((o) => o.id) : [];
  return {
    selectedIds: spec?.mode === 'single' ? recommended.slice(0, 1) : recommended,
    customOptions: [],
    pendingCustom: '',
    text: '',
    note: '',
  };
}

function allOptions(spec: AskUserSpec, draft: AskUserDraft): AskUserOption[] {
  return [
    ...spec.options,
    ...draft.customOptions.map((label, index) => ({ id: `custom:${label}:${index}`, label })),
  ];
}

function draftFromAnswer(answer: AskUserAnswer): AskUserDraft {
  return {
    selectedIds: answer.selected.map((o) => o.id),
    customOptions: answer.customOptions,
    pendingCustom: '',
    text: answer.text,
    note: answer.note,
  };
}

function optionsForRender(spec: AskUserSpec, draft: AskUserDraft, answer?: AskUserAnswer): AskUserOption[] {
  if (!answer) return allOptions(spec, draft);
  const selectedIds = new Set(answer.selected.map((o) => o.id));
  const base = spec.options.map((option) => selectedIds.has(option.id) ? { ...option, recommended: option.recommended } : option);
  const custom = answer.customOptions.map((label, index) => ({ id: `custom:${label}:${index}`, label }));
  const selectedMissing = answer.selected.filter((option) => !base.some((x) => x.id === option.id) && !custom.some((x) => x.id === option.id));
  return [...base, ...custom, ...selectedMissing];
}

function selectedOptions(spec: AskUserSpec, draft: AskUserDraft): AskUserOption[] {
  const byId = new Map(allOptions(spec, draft).map((o) => [o.id, o]));
  return draft.selectedIds.map((id) => byId.get(id)).filter((o): o is AskUserOption => !!o);
}

function requiredOptions(spec: AskUserSpec): AskUserOption[] {
  return spec.options.filter((option) => option.required);
}

function uniqueOptions(options: AskUserOption[]): AskUserOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

function recommendedOptions(spec: AskUserSpec): AskUserOption[] {
  const required = requiredOptions(spec);
  const recommended = spec.options.filter((option) => option.recommended);
  const candidates = uniqueOptions([...required, ...recommended]);
  return spec.mode === 'single' ? candidates.slice(0, 1) : candidates;
}

function canSubmitDraft(spec: AskUserSpec, draft: AskUserDraft): boolean {
  if (spec.mode === 'text') return spec.required ? !!draft.text.trim() : !!draft.text.trim() || !!draft.note.trim();
  const selectedIds = new Set(draft.selectedIds);
  const requiredSatisfied = requiredOptions(spec).every((option) => selectedIds.has(option.id));
  if (!requiredSatisfied) return false;
  return spec.required ? draft.selectedIds.length > 0 : draft.selectedIds.length > 0 || !!draft.note.trim();
}

export function answerFromDraft(spec: AskUserSpec, draft: AskUserDraft, usedRecommended = false): AskUserAnswer {
  return {
    mode: spec.mode,
    selected: spec.mode === 'text' ? [] : selectedOptions(spec, draft),
    customOptions: draft.customOptions,
    text: spec.mode === 'text' ? draft.text.trim() : '',
    note: draft.note.trim(),
    usedRecommended,
  };
}

export function recommendedAnswer(spec: AskUserSpec, draft: AskUserDraft): AskUserAnswer {
  const recommended = recommendedOptions(spec);
  return {
    mode: spec.mode,
    selected: spec.mode === 'text' ? [] : recommended,
    customOptions: [],
    text: '',
    note: draft.note.trim() || '按推荐选项处理。 / Use the recommended option(s).',
    usedRecommended: true,
  };
}

function OptionRow({
  option,
  checked,
  multi,
  disabled,
  onClick,
}: {
  option: AskUserOption;
  checked: boolean;
  multi: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
        checked ? 'border-primary bg-primary/5 text-foreground' : 'bg-background hover:bg-accent',
        disabled && 'cursor-default hover:bg-background',
      )}
    >
      {multi ? (
        <SquareCheckBig className={cn('mt-0.5 size-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')} />
      ) : checked ? (
        <Check className="mt-0.5 size-4 shrink-0 text-primary" />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{option.label}</span>
          {option.required && <span className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">必选</span>}
          {option.recommended && <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">推荐</span>}
        </span>
        {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
      </span>
    </button>
  );
}

export function AskUserQuestionCard({
  spec,
  draft,
  answer,
  disabled,
  onDraftChange,
  onSubmit,
  onCancel,
}: {
  spec: AskUserSpec;
  draft: AskUserDraft;
  answer?: AskUserAnswer;
  disabled?: boolean;
  onDraftChange: (draft: AskUserDraft) => void;
  onSubmit: (answer: AskUserAnswer) => void;
  onCancel: () => void;
}) {
  const readonly = !!answer;
  const viewDraft = answer ? draftFromAnswer(answer) : draft;
  const options = optionsForRender(spec, viewDraft, answer);
  const canSubmit = canSubmitDraft(spec, viewDraft);
  const canUseRecommended = canSubmitDraft(spec, {
    ...draft,
    selectedIds: recommendedOptions(spec).map((option) => option.id),
    text: '',
    note: draft.note.trim() || '按推荐选项处理。 / Use the recommended option(s).',
  });

  const toggle = (id: string) => {
    if (readonly) return;
    if (spec.mode === 'single') onDraftChange({ ...draft, selectedIds: [id] });
    else {
      const selectedIds = draft.selectedIds.includes(id)
        ? draft.selectedIds.filter((x) => x !== id)
        : [...draft.selectedIds, id];
      onDraftChange({ ...draft, selectedIds });
    }
  };

  const addCustom = () => {
    const label = draft.pendingCustom.trim();
    if (!label) return;
    const nextCustom = [...draft.customOptions, label];
    const id = `custom:${label}:${nextCustom.length - 1}`;
    onDraftChange({
      ...draft,
      customOptions: nextCustom,
      pendingCustom: '',
      selectedIds: spec.mode === 'single' ? [id] : [...draft.selectedIds, id],
    });
  };

  return (
    <div className="not-prose rounded-md border bg-card p-3 text-sm shadow-sm">
      <div className="font-medium">{readonly ? '已提交回答' : '需要你回答'}</div>
      <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{spec.question}</div>

      {spec.mode === 'text' ? (
        <Textarea
          className="mt-3 min-h-24"
          value={viewDraft.text}
          disabled={disabled || readonly}
          onChange={(event) => onDraftChange({ ...draft, text: event.currentTarget.value })}
          placeholder="填写回答内容"
        />
      ) : (
        <div className="mt-3 space-y-2">
          {options.map((option) => (
            <OptionRow
              key={option.id}
              option={option}
              multi={spec.mode === 'multiple'}
              checked={viewDraft.selectedIds.includes(option.id)}
              disabled={disabled || readonly}
              onClick={() => toggle(option.id)}
            />
          ))}
          {spec.allowCustom && !readonly && (
            <div className="flex gap-2">
              <Input
                value={draft.pendingCustom}
                disabled={disabled}
                onChange={(event) => onDraftChange({ ...draft, pendingCustom: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCustom();
                  }
                }}
                placeholder={spec.mode === 'single' ? '添加自定义选项' : '添加一个或多个自定义选项'}
              />
              <Button type="button" variant="outline" size="icon" disabled={disabled || !draft.pendingCustom.trim()} onClick={addCustom} title="添加选项">
                <Plus className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">用户补充说明</span>
        <Textarea
          className="min-h-20"
          value={viewDraft.note}
          disabled={disabled || readonly}
          onChange={(event) => onDraftChange({ ...draft, note: event.currentTarget.value })}
          placeholder="可补充背景、约束或理由"
        />
      </label>

      {!readonly && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onCancel}>
            <X className="size-4" />
            取消对话
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled || !canUseRecommended} onClick={() => onSubmit(recommendedAnswer(spec, draft))}>
            <Sparkles className="size-4" />
            按推荐处理
          </Button>
          <Button type="button" size="sm" disabled={disabled || !canSubmit} onClick={() => onSubmit(answerFromDraft(spec, draft))}>
            提交回答
          </Button>
        </div>
      )}
    </div>
  );
}
