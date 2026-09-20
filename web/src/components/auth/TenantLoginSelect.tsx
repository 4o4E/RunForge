import { useEffect, useState } from 'react';
import type { LoginTenantSummary } from '@runforge/contracts';
import { listLoginTenants } from '@/api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function TenantLoginSelect({ value, onChange }: { value: string; onChange: (tenantId: string) => void }) {
  const [tenants, setTenants] = useState<LoginTenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;
    void listLoginTenants()
      .then(({ tenants: available }) => {
        if (canceled) return;
        setTenants(available);
        if (!available.length) {
          setError('没有可登录的租户');
          return;
        }
        onChange(available.find((tenant) => tenant.isDefault)?.id ?? available[0].id);
      })
      .catch((reason) => {
        if (!canceled) setError((reason as Error).message || '读取租户列表失败');
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => { canceled = true; };
  }, [onChange]);

  return (
    <div className="space-y-1">
      <label htmlFor="login-tenant" className="text-sm font-medium">租户</label>
      <Select value={value} onValueChange={onChange} disabled={loading || !!error}>
        <SelectTrigger id="login-tenant" aria-label="租户">
          <SelectValue placeholder={loading ? '正在读取租户…' : '选择租户'} />
        </SelectTrigger>
        <SelectContent>
          {tenants.map((tenant) => (
            <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
