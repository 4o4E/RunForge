import { Plus, RefreshCw, Save, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  createDatasource,
  createPermissionProfile,
  createReadonlyProfile,
  getDatasourceDetail,
  listDatasources,
  testDatasource,
  testDatasourceDraft,
  updateDatasource,
  updatePermissionProfile,
  type Datasource,
  type DatasourceAccount,
  type DatasourceInput,
  type DatasourceLease,
  type DatasourceStatus,
  type DatasourceTestResult,
  type DatasourceType,
  type PermissionMode,
  type PermissionProfile,
  type PermissionProfileInput,
} from '../../api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Field, shortTime } from '../SettingsView';

export type DatasourceSettingsPage = 'datasource-connection' | 'datasource-permissions' | 'datasource-pool' | 'datasource-leases';

interface DatasourceDetail {
  datasource: Datasource;
  profiles: PermissionProfile[];
  accounts: DatasourceAccount[];
  leases: DatasourceLease[];
}

interface DatasourceForm {
  name: string;
  type: DatasourceType;
  status: DatasourceStatus;
  enabled: boolean;
  host: string;
  port: string;
  database: string;
  adminConnectionUrl: string;
  maxPoolSize: string;
  leaseTtlSeconds: string;
}

interface ProfileForm {
  profileId: string | null;
  name: string;
  mode: PermissionMode;
  templateRole: string;
  maxPoolSize: string;
  leaseTtlSeconds: string;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'active' || status === 'idle' || status === 'released') return 'secondary';
  if (status === 'leased') return 'default';
  if (status === 'disabled' || status === 'failed') return 'destructive';
  return 'outline';
}

function stringField(value: unknown, fallback = ''): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value;
  return fallback;
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} 必须是正数`);
  return Math.floor(parsed);
}

function optionalPositiveNumber(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  return positiveNumber(value, label);
}

function datasourceToForm(datasource?: Datasource): DatasourceForm {
  const connection = datasource?.connection ?? {};
  const poolConfig = datasource?.pool_config ?? {};
  return {
    name: datasource?.name ?? '',
    type: datasource?.type ?? 'postgres',
    status: datasource?.status ?? 'active',
    enabled: datasource?.enabled ?? true,
    host: stringField(connection.host),
    port: stringField(connection.port, datasource?.type === 'hive' ? '10000' : datasource?.type === 'mongodb' ? '27017' : datasource?.type === 'mysql' ? '3306' : '5432'),
    database: stringField(connection.database),
    adminConnectionUrl: '',
    maxPoolSize: stringField(poolConfig.maxPoolSize, '20'),
    leaseTtlSeconds: stringField(poolConfig.leaseTtlSeconds, '1800'),
  };
}

function emptyProfileForm(): ProfileForm {
  return {
    profileId: null,
    name: 'readonly',
    mode: 'readonly',
    templateRole: '',
    maxPoolSize: '',
    leaseTtlSeconds: '',
  };
}

function profileToForm(profile: PermissionProfile): ProfileForm {
  const poolConfig = profile.pool_config ?? {};
  return {
    profileId: profile.id,
    name: profile.name,
    mode: profile.mode,
    templateRole: profile.template_role ?? '',
    maxPoolSize: stringField(poolConfig.maxPoolSize),
    leaseTtlSeconds: stringField(poolConfig.leaseTtlSeconds),
  };
}

function accountProfileName(account: DatasourceAccount, profiles: PermissionProfile[]): string {
  return profiles.find((profile) => profile.id === account.profile_id)?.name ?? account.profile_id.slice(0, 8);
}

export function DatasourceSettingsPanel({ page }: { page: DatasourceSettingsPage }) {
  const [datasources, setDatasources] = useState<Datasource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DatasourceDetail | null>(null);
  const [datasourceForm, setDatasourceForm] = useState<DatasourceForm>(() => datasourceToForm());
  const [profileForm, setProfileForm] = useState<ProfileForm>(() => emptyProfileForm());
  const [loading, setLoading] = useState(false);
  const [savingDatasource, setSavingDatasource] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [creatingReadonlyProfile, setCreatingReadonlyProfile] = useState(false);
  const [testingDatasource, setTestingDatasource] = useState(false);
  const [testResult, setTestResult] = useState<DatasourceTestResult | null>(null);
  const [message, setMessage] = useState('');

  const selectedDatasource = detail?.datasource ?? datasources.find((item) => item.id === selectedId) ?? null;

  async function refreshList(nextSelectedId = selectedId) {
    const result = await listDatasources();
    setDatasources(result.datasources);
    const targetId = nextSelectedId ?? result.datasources[0]?.id ?? null;
    setSelectedId(targetId);
    if (targetId) await refreshDetail(targetId);
    else {
      setDetail(null);
      setDatasourceForm(datasourceToForm());
      setProfileForm(emptyProfileForm());
    }
  }

  async function refreshDetail(id: string) {
    setLoading(true);
    try {
      const next = await getDatasourceDetail(id);
      setDetail(next);
      setDatasourceForm(datasourceToForm(next.datasource));
      setProfileForm(next.profiles[0] ? profileToForm(next.profiles[0]) : emptyProfileForm());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let canceled = false;
    listDatasources()
      .then(async (result) => {
        if (canceled) return;
        setDatasources(result.datasources);
        const first = result.datasources[0]?.id ?? null;
        setSelectedId(first);
        if (first) {
          const next = await getDatasourceDetail(first);
          if (canceled) return;
          setDetail(next);
          setDatasourceForm(datasourceToForm(next.datasource));
          setProfileForm(next.profiles[0] ? profileToForm(next.profiles[0]) : emptyProfileForm());
        }
      })
      .catch((err) => {
        if (!canceled) setMessage(`读取数据源失败：${(err as Error).message}`);
      });
    return () => {
      canceled = true;
    };
  }, []);

  function newDatasource() {
    setSelectedId(null);
    setDetail(null);
    setDatasourceForm(datasourceToForm());
    setProfileForm(emptyProfileForm());
    setTestResult(null);
    setMessage('');
  }

  async function selectDatasource(id: string) {
    setSelectedId(id);
    setTestResult(null);
    setMessage('');
    await refreshDetail(id);
  }

  function datasourceInputFromForm(): DatasourceInput {
    const connection = {
      ...(selectedDatasource?.connection ?? {}),
      host: datasourceForm.host.trim(),
      port: positiveNumber(datasourceForm.port, '端口'),
      database: datasourceForm.database.trim(),
    };
    const poolConfig = {
      ...(selectedDatasource?.pool_config ?? {}),
      maxPoolSize: positiveNumber(datasourceForm.maxPoolSize, '最大账号数'),
      leaseTtlSeconds: positiveNumber(datasourceForm.leaseTtlSeconds, '租约有效期'),
    };
    const input: DatasourceInput = {
      name: datasourceForm.name.trim(),
      type: datasourceForm.type,
      status: datasourceForm.status,
      enabled: datasourceForm.enabled,
      connection,
      poolConfig,
    };
    if (datasourceForm.adminConnectionUrl.trim()) {
      input.adminConfig = { connectionUrl: datasourceForm.adminConnectionUrl.trim() };
    }
    return input;
  }

  async function saveDatasource() {
    setSavingDatasource(true);
    setMessage('');
    try {
      const input = datasourceInputFromForm();

      const result = selectedDatasource
        ? await updateDatasource(selectedDatasource.id, input)
        : await createDatasource(input);
      setMessage('数据源已保存');
      await refreshList(result.datasource.id);
    } catch (err) {
      setMessage(`保存数据源失败：${(err as Error).message}`);
    } finally {
      setSavingDatasource(false);
    }
  }

  async function testCurrentDatasource() {
    setTestingDatasource(true);
    setMessage('');
    setTestResult(null);
    try {
      const input = datasourceInputFromForm();
      const result = selectedDatasource
        ? await testDatasource(selectedDatasource.id, datasourceForm.adminConnectionUrl.trim() ? { adminConfig: input.adminConfig } : {})
        : await testDatasourceDraft(input);
      setTestResult(result);
      setMessage(`连接成功，发现 ${result.tableCount} 张表`);
    } catch (err) {
      setMessage(`测试连接失败：${(err as Error).message}`);
    } finally {
      setTestingDatasource(false);
    }
  }

  async function saveProfile() {
    if (!selectedDatasource) return;
    setSavingProfile(true);
    setMessage('');
    try {
      const poolConfig = {
        ...(detail?.profiles.find((profile) => profile.id === profileForm.profileId)?.pool_config ?? {}),
      };
      const maxPoolSize = optionalPositiveNumber(profileForm.maxPoolSize, '最大账号数');
      const leaseTtlSeconds = optionalPositiveNumber(profileForm.leaseTtlSeconds, '租约有效期');
      if (maxPoolSize != null) poolConfig.maxPoolSize = maxPoolSize;
      else delete poolConfig.maxPoolSize;
      if (leaseTtlSeconds != null) poolConfig.leaseTtlSeconds = leaseTtlSeconds;
      else delete poolConfig.leaseTtlSeconds;

      const input: PermissionProfileInput = {
        name: profileForm.name.trim(),
        mode: profileForm.mode,
        templateRole: profileForm.templateRole.trim() || undefined,
        grants: detail?.profiles.find((profile) => profile.id === profileForm.profileId)?.grants ?? {},
        poolConfig,
      };
      if (profileForm.profileId) await updatePermissionProfile(selectedDatasource.id, profileForm.profileId, input);
      else await createPermissionProfile(selectedDatasource.id, input);
      setMessage('权限档位已保存');
      await refreshDetail(selectedDatasource.id);
    } catch (err) {
      setMessage(`保存权限档位失败：${(err as Error).message}`);
    } finally {
      setSavingProfile(false);
    }
  }

  async function createDefaultReadonlyProfile() {
    if (!selectedDatasource) return;
    setCreatingReadonlyProfile(true);
    setMessage('');
    try {
      await createReadonlyProfile(selectedDatasource.id);
      setMessage('只读档位已创建');
      await refreshDetail(selectedDatasource.id);
    } catch (err) {
      setMessage(`创建只读档位失败：${(err as Error).message}`);
    } finally {
      setCreatingReadonlyProfile(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {page === 'datasource-connection'
              ? '数据源连接'
              : page === 'datasource-permissions'
                ? '数据源权限'
                : page === 'datasource-pool'
                  ? '数据源账号池'
                  : '数据源租约'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {page === 'datasource-connection'
              ? '配置数据库入口和管理连接'
              : page === 'datasource-permissions'
                ? '维护账号池继承的权限档位'
                : page === 'datasource-pool'
                  ? '查看短期数据库凭证账号状态'
                  : '查看账号池租约记录和到期状态'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {message && <span className="max-w-md truncate text-sm text-muted-foreground">{message}</span>}
          <Button variant="outline" onClick={() => void refreshList()} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          <Button onClick={newDatasource}>
            <Plus className="h-4 w-4" />
            新建数据源
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
          <CardHeader className="shrink-0">
            <CardTitle className="text-base">数据源</CardTitle>
            <CardDescription>{datasources.length} 个连接入口</CardDescription>
          </CardHeader>
          <CardContent className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
            {datasources.length === 0 && <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">暂无数据源</div>}
            {datasources.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void selectDatasource(item.id)}
                className={cn(
                  'grid gap-1 rounded-md border p-3 text-left transition-colors',
                  item.id === selectedId ? 'border-primary bg-primary/5' : 'hover:bg-accent/60',
                )}
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {!item.enabled && <Badge variant="outline">LLM 隐藏</Badge>}
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{item.type}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="h-full min-h-0">
          {page === 'datasource-connection' && (
            <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
              <Card className="shrink-0 rounded-lg shadow-sm">
                <CardHeader className="shrink-0">
                  <CardTitle className="text-base">连接配置</CardTitle>
                  <CardDescription>
                    {selectedDatasource?.hasAdminConfig ? '已保存管理配置；留空不会覆盖' : '尚未保存管理配置'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                  <div className="grid gap-2 text-sm font-medium md:col-span-2">
                    <span>LLM 可见性</span>
                    <div className="inline-flex h-10 w-fit items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm">
                      <span className={cn(!datasourceForm.enabled ? 'text-foreground' : 'text-muted-foreground')}>隐藏</span>
                      <Switch
                        checked={datasourceForm.enabled}
                        onCheckedChange={(enabled) => setDatasourceForm({ ...datasourceForm, enabled })}
                      />
                      <span className={cn(datasourceForm.enabled ? 'text-foreground' : 'text-muted-foreground')}>可见</span>
                    </div>
                  </div>
                  <Field label="名称">
                    <Input value={datasourceForm.name} onChange={(event) => setDatasourceForm({ ...datasourceForm, name: event.target.value })} />
                  </Field>
                  <Field label="类型">
                    <Select
                      value={datasourceForm.type}
                      onValueChange={(value) => setDatasourceForm({ ...datasourceForm, type: value as DatasourceType })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="postgres">postgres</SelectItem>
                        <SelectItem value="mysql">mysql</SelectItem>
                        <SelectItem value="mongodb">mongodb</SelectItem>
                        <SelectItem value="hive">hive</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="状态">
                    <Select
                      value={datasourceForm.status}
                      onValueChange={(value) => setDatasourceForm({ ...datasourceForm, status: value as DatasourceStatus })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">active</SelectItem>
                        <SelectItem value="disabled">disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="主机">
                    <Input value={datasourceForm.host} onChange={(event) => setDatasourceForm({ ...datasourceForm, host: event.target.value })} />
                  </Field>
                  <Field label="端口">
                    <Input
                      type="number"
                      min={1}
                      value={datasourceForm.port}
                      onChange={(event) => setDatasourceForm({ ...datasourceForm, port: event.target.value })}
                    />
                  </Field>
                  <Field label="数据库名">
                    <Input value={datasourceForm.database} onChange={(event) => setDatasourceForm({ ...datasourceForm, database: event.target.value })} />
                  </Field>
                  <Field label="最大账号数">
                    <Input
                      type="number"
                      min={1}
                      value={datasourceForm.maxPoolSize}
                      onChange={(event) => setDatasourceForm({ ...datasourceForm, maxPoolSize: event.target.value })}
                    />
                  </Field>
                  <Field label="租约有效期（秒）">
                    <Input
                      type="number"
                      min={1}
                      value={datasourceForm.leaseTtlSeconds}
                      onChange={(event) => setDatasourceForm({ ...datasourceForm, leaseTtlSeconds: event.target.value })}
                    />
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="管理连接 URL">
                      <Input
                        type="password"
                        value={datasourceForm.adminConnectionUrl}
                        placeholder={selectedDatasource?.hasAdminConfig ? '已保存；留空不覆盖' : 'postgres://agent_admin:password@host:5432/db'}
                        onChange={(event) => setDatasourceForm({ ...datasourceForm, adminConnectionUrl: event.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground md:col-span-2">
                    当前 PostgreSQL 适配器使用管理连接 URL 创建、改密和锁定池账号；MySQL、MongoDB、Hive 适配器后续接入后会复用这些字段。
                  </div>
                  <div className="md:col-span-2">
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => void testCurrentDatasource()} disabled={testingDatasource || !datasourceForm.name.trim()}>
                        <RefreshCw className="h-4 w-4" />
                        {testingDatasource ? '测试中' : '测试连接'}
                      </Button>
                      <Button onClick={() => void saveDatasource()} disabled={savingDatasource || !datasourceForm.name.trim()}>
                        <Save className="h-4 w-4" />
                        {savingDatasource ? '保存中' : '保存数据源'}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {testResult && (
                <Card className="flex min-h-80 shrink-0 flex-col rounded-lg shadow-sm">
                  <CardHeader className="shrink-0">
                    <CardTitle className="text-base">连接测试结果</CardTitle>
                    <CardDescription>
                      {testResult.database ? `${testResult.database} · ` : ''}
                      {testResult.tableCount} 张表
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid max-h-80 gap-2 overflow-y-auto">
                    {testResult.tables.length === 0 && (
                      <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">连接成功，但没有发现用户表</div>
                    )}
                    {testResult.tables.map((table) => (
                      <div key={`${table.schema}.${table.name}`} className="rounded-md border">
                        <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{table.schema}.{table.name}</div>
                            <div className="text-xs text-muted-foreground">{table.type}</div>
                          </div>
                          <Badge variant="outline">{table.columns.length} 列</Badge>
                        </div>
                        <div className="grid gap-1 p-3">
                          {table.columns.slice(0, 12).map((column) => (
                            <div key={column.name} className="grid gap-1 text-xs sm:grid-cols-[minmax(0,1fr)_10rem_4rem] sm:gap-2">
                              <span className="truncate font-medium">{column.name}</span>
                              <span className="truncate text-muted-foreground">{column.type}</span>
                              <span className="text-muted-foreground">{column.nullable ? 'NULL' : 'NOT NULL'}</span>
                            </div>
                          ))}
                          {table.columns.length > 12 && (
                            <div className="text-xs text-muted-foreground">还有 {table.columns.length - 12} 列未展开</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {page === 'datasource-permissions' && <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
            <CardHeader className="shrink-0">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">权限档位</CardTitle>
                  <CardDescription>账号池账号继承模板角色</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void createDefaultReadonlyProfile()}
                    disabled={!selectedDatasource || creatingReadonlyProfile}
                  >
                    <Shield className="h-4 w-4" />
                    {creatingReadonlyProfile ? '创建中' : '创建只读档位'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setProfileForm(emptyProfileForm())} disabled={!selectedDatasource}>
                    <Plus className="h-4 w-4" />
                    新建档位
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto">
              {detail?.profiles.length ? (
                <div className="flex max-h-28 flex-wrap content-start gap-2 overflow-y-auto rounded-md border bg-muted/20 p-2">
                  {detail.profiles.map((profile) => (
                    <Button
                      key={profile.id}
                      type="button"
                      variant={profileForm.profileId === profile.id ? 'secondary' : 'outline'}
                      size="sm"
                      onClick={() => setProfileForm(profileToForm(profile))}
                    >
                      <Shield className="h-4 w-4" />
                      {profile.name}
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">暂无权限档位</div>
              )}
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="档位名称">
                  <Input value={profileForm.name} onChange={(event) => setProfileForm({ ...profileForm, name: event.target.value })} />
                </Field>
                <Field label="模式">
                  <Select value={profileForm.mode} onValueChange={(value) => setProfileForm({ ...profileForm, mode: value as PermissionMode })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="readonly">readonly</SelectItem>
                      <SelectItem value="limited_write">limited_write</SelectItem>
                      <SelectItem value="custom">custom</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="模板角色">
                  <Input value={profileForm.templateRole} onChange={(event) => setProfileForm({ ...profileForm, templateRole: event.target.value })} />
                </Field>
                <Field label="最大账号数">
                  <Input
                    type="number"
                    min={1}
                    value={profileForm.maxPoolSize}
                    placeholder="继承数据源配置"
                    onChange={(event) => setProfileForm({ ...profileForm, maxPoolSize: event.target.value })}
                  />
                </Field>
                <Field label="租约有效期（秒）">
                  <Input
                    type="number"
                    min={1}
                    value={profileForm.leaseTtlSeconds}
                    placeholder="继承数据源配置"
                    onChange={(event) => setProfileForm({ ...profileForm, leaseTtlSeconds: event.target.value })}
                  />
                </Field>
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground md:col-span-3">
                  表、列、行级权限应由数据库模板角色或 Ranger 兜底；这个档位只绑定模板角色和账号池覆盖参数。
                </div>
              </div>
              <Button onClick={() => void saveProfile()} disabled={savingProfile || !selectedDatasource || !profileForm.name.trim()}>
                <Save className="h-4 w-4" />
                {savingProfile ? '保存中' : '保存权限档位'}
              </Button>
            </CardContent>
          </Card>}

          {page === 'datasource-pool' && (
            <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
              <CardHeader className="shrink-0">
                <CardTitle className="text-base">账号池</CardTitle>
                <CardDescription>{detail?.accounts.length ?? 0} 个账号</CardDescription>
              </CardHeader>
              <CardContent className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
                {!detail?.accounts.length && <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">暂无池账号</div>}
                {detail?.accounts.map((account) => (
                  <div key={account.id} className="grid gap-1 rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{account.username}</span>
                      <Badge variant={statusVariant(account.status)}>{account.status}</Badge>
                    </div>
                    <div className="grid gap-1 text-xs text-muted-foreground">
                      <span>档位：{accountProfileName(account, detail.profiles)}</span>
                      <span>run：{account.current_run_id ?? '-'}</span>
                      <span>租约到期：{shortTime(account.leased_until)}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {page === 'datasource-leases' && (
            <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-sm">
              <CardHeader className="shrink-0">
                <CardTitle className="text-base">最近租约</CardTitle>
                <CardDescription>{detail?.leases.length ?? 0} 条记录</CardDescription>
              </CardHeader>
              <CardContent className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
                {!detail?.leases.length && <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">暂无租约</div>}
                {detail?.leases.map((lease) => (
                  <div key={lease.id} className="grid gap-1 rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{lease.id}</span>
                      <Badge variant={statusVariant(lease.status)}>{lease.status}</Badge>
                    </div>
                    <div className="grid gap-1 text-xs text-muted-foreground">
                      <span>run：{lease.run_id}</span>
                      <span>租出：{shortTime(lease.leased_at)}</span>
                      <span>到期：{shortTime(lease.expires_at)}</span>
                      {lease.error && <span className="text-destructive">错误：{lease.error}</span>}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
