import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Save } from 'lucide-react';
import { getToolSettings, updateToolSettings, type ToolSettings } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

function listToText(items: string[]): string {
  return items.join('\n');
}

function textToList(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SettingsView({ onWorkspaceChanged }: { onWorkspaceChanged: () => void }) {
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [allowText, setAllowText] = useState('');
  const [denyText, setDenyText] = useState('');
  const [shellCommandsText, setShellCommandsText] = useState('');
  const [shellDenyText, setShellDenyText] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let canceled = false;
    getToolSettings()
      .then((data) => {
        if (canceled) return;
        setSettings(data);
        setAllowText(listToText(data.allow));
        setDenyText(listToText(data.deny));
        setShellCommandsText(listToText(data.shellAllowCommands));
        setShellDenyText(listToText(data.shellDeny));
      })
      .catch((err) => {
        if (!canceled) setMessage(`读取配置失败：${(err as Error).message}`);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const prepared = useMemo<ToolSettings | null>(() => {
    if (!settings) return null;
    return {
      ...settings,
      allow: textToList(allowText),
      deny: textToList(denyText),
      shellAllowCommands: textToList(shellCommandsText),
      shellDeny: textToList(shellDenyText),
      maxOutput: Math.max(1000, Math.floor(Number(settings.maxOutput) || 1000)),
    };
  }, [allowText, denyText, settings, shellCommandsText, shellDenyText]);

  async function save() {
    if (!prepared) return;
    setSaving(true);
    setMessage('');
    try {
      const next = await updateToolSettings(prepared);
      setSettings(next);
      setAllowText(listToText(next.allow));
      setDenyText(listToText(next.deny));
      setShellCommandsText(listToText(next.shellAllowCommands));
      setShellDenyText(listToText(next.shellDeny));
      onWorkspaceChanged();
      setMessage('已保存');
    } catch (err) {
      setMessage(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <main className="flex h-full flex-1 items-center justify-center text-sm text-muted-foreground">正在读取配置...</main>;
  }

  return (
    <main className="h-full flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">配置</h1>
            <p className="mt-1 text-sm text-muted-foreground">工具沙箱和网络策略</p>
          </div>
          <div className="flex items-center gap-3">
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
            <Button onClick={() => void save()} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? '保存中' : '保存'}
            </Button>
          </div>
        </div>

        <Card className="rounded-lg shadow-sm">
          <CardHeader>
            <CardTitle>工具沙箱</CardTitle>
            <CardDescription>控制工具是否启用路径限制和 bwrap 后端</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <Field label="沙箱模式">
              <Select value={settings.sandbox} onValueChange={(value) => setSettings({ ...settings, sandbox: value as ToolSettings['sandbox'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">off</SelectItem>
                  <SelectItem value="enforce">enforce</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="沙箱后端">
              <Select
                value={settings.sandboxBackend}
                onValueChange={(value) => setSettings({ ...settings, sandboxBackend: value as ToolSettings['sandboxBackend'] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="none">none</SelectItem>
                  <SelectItem value="bwrap">bwrap</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="网络">
              <Select value={settings.network} onValueChange={(value) => setSettings({ ...settings, network: value as ToolSettings['network'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="disabled">disabled</SelectItem>
                  <SelectItem value="enabled">enabled</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="md:col-span-3">
              <Field label="工作区根目录">
                <Input value={settings.workspaceRoot} onChange={(event) => setSettings({ ...settings, workspaceRoot: event.target.value })} />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg shadow-sm">
          <CardHeader>
            <CardTitle>工具准入</CardTitle>
            <CardDescription>allow 非空时只允许列表内工具，deny 始终优先</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="允许工具">
              <Textarea rows={5} value={allowText} onChange={(event) => setAllowText(event.target.value)} />
            </Field>
            <Field label="禁用工具">
              <Textarea rows={5} value={denyText} onChange={(event) => setDenyText(event.target.value)} />
            </Field>
          </CardContent>
        </Card>

        <Card className="rounded-lg shadow-sm">
          <CardHeader>
            <CardTitle>Shell</CardTitle>
            <CardDescription>控制 shell 工具、可见外部命令和命令 deny 正则</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="启用 shell">
              <Select
                value={settings.shellEnabled ? 'true' : 'false'}
                onValueChange={(value) => setSettings({ ...settings, shellEnabled: value === 'true' })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">true</SelectItem>
                  <SelectItem value="false">false</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="单条工具结果上限">
              <Input
                type="number"
                min={1000}
                value={settings.maxOutput}
                onChange={(event) => setSettings({ ...settings, maxOutput: Number(event.target.value) })}
              />
            </Field>
            <Field label="bwrap 可见命令">
              <Textarea rows={8} value={shellCommandsText} onChange={(event) => setShellCommandsText(event.target.value)} />
            </Field>
            <Field label="Shell deny 正则">
              <Textarea rows={8} value={shellDenyText} onChange={(event) => setShellDenyText(event.target.value)} />
            </Field>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
