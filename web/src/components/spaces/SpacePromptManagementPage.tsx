import { useEffect, useMemo, useState } from 'react';
import type { PromptPlaceholder, SpaceSummary } from '@runforge/contracts';
import { ArrowLeft, Save } from 'lucide-react';
import type { SpaceControlApi } from '@/spaceControlApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { SpacePromptEditor } from './SpacePromptEditor';

interface Props {
  api: SpaceControlApi;
  spaceId: string;
  onBack: () => void;
}

const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_.]*)\s*}}/g;

function promptContent(
  template: string,
  placeholders: readonly PromptPlaceholder[],
): string {
  const contents = new Map(placeholders.map((placeholder) => [placeholder.key, placeholder.content.trim()]));
  return template
    .replace(PLACEHOLDER_PATTERN, (token, key: string) => contents.get(key) ?? token)
    .trim();
}

export function SpacePromptManagementPage({ api, spaceId, onBack }: Props) {
  const [space, setSpace] = useState<SpaceSummary | null>(null);
  const [placeholders, setPlaceholders] = useState<PromptPlaceholder[]>([]);
  const [template, setTemplate] = useState('');
  const [savedTemplate, setSavedTemplate] = useState('');
  const [loadingError, setLoadingError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const dirty = Boolean(space) && template !== savedTemplate;
  const previewContent = useMemo(
    () => promptContent(template, placeholders),
    [template, placeholders],
  );

  useEffect(() => {
    let active = true;
    setSpace(null);
    setPlaceholders([]);
    setLoadingError('');
    setSaveMessage('');
    void Promise.all([api.getSpace(spaceId), api.getPromptPlaceholders(spaceId)])
      .then(([loadedSpace, loadedPlaceholders]) => {
        if (!active) return;
        setSpace(loadedSpace);
        setPlaceholders(loadedPlaceholders.placeholders);
        setTemplate(loadedSpace.config.promptTemplate);
        setSavedTemplate(loadedSpace.config.promptTemplate);
      })
      .catch((error) => {
        if (active) setLoadingError((error as Error).message);
      });
    return () => {
      active = false;
    };
  }, [api, spaceId]);

  async function save() {
    if (!space || !dirty || saving) return;
    const submittedTemplate = template;
    setSaving(true);
    setSaveMessage('');
    try {
      const updated = await api.updateSpace(space.id, {
        config: { schemaVersion: 3, promptTemplate: template },
      });
      setSpace(updated);
      setSavedTemplate(updated.config.promptTemplate);
      setTemplate((current) => current === submittedTemplate ? updated.config.promptTemplate : current);
      setSaveMessage('提示词已保存。');
    } catch (error) {
      setSaveMessage(`保存失败：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadingError) {
    return (
      <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
        <CardHeader><CardTitle className="text-base">提示词管理</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <div className="text-sm text-destructive">读取空间失败：{loadingError}</div>
          <Button className="w-fit" variant="outline" onClick={onBack}><ArrowLeft className="size-4" />返回空间管理</Button>
        </CardContent>
      </Card>
    );
  }

  if (!space) {
    return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  }

  return (
    <div className="grid h-full min-h-0 gap-4 overflow-y-auto lg:grid-cols-2 lg:overflow-hidden">
      <Card className="flex min-h-0 flex-col rounded-lg shadow-sm">
        <CardHeader className="shrink-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{space.name}</CardTitle>
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{space.id}</div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="size-4" />返回</Button>
              <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || Boolean(space.deletedAt)}>
                <Save className="size-4" />{saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
          {space.deletedAt && <div className="text-sm text-destructive">空间已经删除，请先恢复空间再修改提示词。</div>}
          {dirty && !saveMessage && <div className="text-sm text-muted-foreground">提示词有未保存的修改。</div>}
          {saveMessage && <div className={saveMessage.startsWith('保存失败') ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{saveMessage}</div>}
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <SpacePromptEditor
            template={template}
            placeholders={placeholders}
            onTemplateChange={(nextTemplate) => {
              setTemplate(nextTemplate);
              setSaveMessage('');
            }}
          />
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col rounded-lg shadow-sm">
        <CardContent className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid content-start gap-3">
            <div className="text-sm font-medium">提示词预览</div>
            {previewContent
              ? <pre className="whitespace-pre-wrap break-words font-mono text-sm">{previewContent}</pre>
              : <div className="text-sm text-muted-foreground">当前没有启用的提示词内容。</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
