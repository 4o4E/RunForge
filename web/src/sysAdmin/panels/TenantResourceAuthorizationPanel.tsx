import { useEffect, useState } from 'react';
import { Database, Save, Server } from 'lucide-react';
import type {
  TenantResourceAuthorization,
  TenantResourceAuthorizationView,
  TenantSummary,
} from '@runforge/contracts';
import {
  getTenantResourceAuthorization,
  updateTenantResourceAuthorization,
} from '../../sysAdminApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';

function toggle(values: string[], value: string, enabled: boolean): string[] {
  return enabled
    ? [...new Set([...values, value])]
    : values.filter((item) => item !== value);
}

export function TenantResourceAuthorizationPanel({
  tenant,
}: {
  tenant: TenantSummary;
}) {
  const [view, setView] = useState<TenantResourceAuthorizationView | null>(null);
  const [draft, setDraft] = useState<TenantResourceAuthorization | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let canceled = false;
    setView(null);
    setDraft(null);
    setMessage('');
    getTenantResourceAuthorization(tenant.id)
      .then((next) => {
        if (canceled) return;
        setView(next);
        setDraft(next.authorization);
      })
      .catch((error) => {
        if (!canceled) setMessage(`读取租户授权失败：${(error as Error).message}`);
      });
    return () => {
      canceled = true;
    };
  }, [tenant.id]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage('');
    try {
      const saved = await updateTenantResourceAuthorization(tenant.id, draft);
      setView(saved);
      setDraft(saved.authorization);
      setMessage('租户授权已保存');
    } catch (error) {
      setMessage(`保存租户授权失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!view || !draft) {
    return (
      <Card className="flex h-full items-center justify-center rounded-lg shadow-sm">
        <CardContent className="p-6 text-sm text-muted-foreground">
          {message || '正在读取租户授权...'}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
      <CardHeader className="shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">{tenant.name} 的系统资源授权</CardTitle>
            <CardDescription>空间只能继续选择这里已经授权给租户的资源</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              <Save className="h-4 w-4" />
              保存授权
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><Server className="h-4 w-4" />LLM 供应商</CardTitle>
            <CardDescription>授权供应商后，该供应商中能力信息完整的模型会进入空间模型目录</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {view.catalog.llmProviders.length === 0 && <div className="text-sm text-muted-foreground">系统尚未配置 LLM 供应商</div>}
            {view.catalog.llmProviders.map((provider) => (
              <label key={provider.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                <Checkbox
                  checked={draft.llmProviderIds.includes(provider.id)}
                  disabled={busy}
                  onCheckedChange={(checked) => setDraft({
                    ...draft,
                    llmProviderIds: toggle(draft.llmProviderIds, provider.id, checked),
                  })}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{provider.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{provider.id} · {provider.models.length} 个模型</span>
                </span>
              </label>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><Database className="h-4 w-4" />数据源</CardTitle>
            <CardDescription>授权后，空间和运行中的数据库工具才能看到并申请对应数据源凭证</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {view.catalog.datasources.length === 0 && <div className="text-sm text-muted-foreground">系统尚未配置数据源</div>}
            {view.catalog.datasources.map((datasource) => (
              <label key={datasource.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                <Checkbox
                  checked={draft.datasourceIds.includes(datasource.id)}
                  disabled={busy}
                  onCheckedChange={(checked) => setDraft({
                    ...draft,
                    datasourceIds: toggle(draft.datasourceIds, datasource.id, checked),
                  })}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2 text-sm font-medium">
                    <span className="truncate">{datasource.name}</span>
                    <Badge variant={datasource.enabled && datasource.status === 'active' ? 'secondary' : 'outline'}>
                      {datasource.enabled && datasource.status === 'active' ? '可用' : '停用'}
                    </Badge>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{datasource.id} · {datasource.type}</span>
                </span>
              </label>
            ))}
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}
