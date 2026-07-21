import React, { FormEvent, useEffect, useState } from 'react';
import { onSysAdminAccessTokenInvalid, sysAdminLogin, sysAdminRestoreSession } from '../sysAdminApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// 系统管理员是完全独立的身份体系(不同 token 存储，见 sysAdminApi.ts)，不需要像
// AdminLoginGate 那样额外校验角色——requireSystemScope 后面没有角色分层。

type SysAdminSessionStatus = 'restoring' | 'anonymous' | 'authenticated';

export function SysAdminLoginGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SysAdminSessionStatus>('restoring');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status !== 'restoring') return;
    let canceled = false;
    void sysAdminRestoreSession().then((ok) => {
      if (!canceled) setStatus(ok ? 'authenticated' : 'anonymous');
    });
    return () => {
      canceled = true;
    };
  }, [status]);

  useEffect(() => onSysAdminAccessTokenInvalid(() => {
    setStatus('anonymous');
    setPassword('');
  }), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await sysAdminLogin(email.trim(), password);
      setStatus('authenticated');
      setPassword('');
    } catch (err) {
      setError((err as Error).message || '登录失败');
    } finally {
      setSubmitting(false);
    }
  }

  if (status === 'restoring') return null;
  if (status === 'authenticated') return <>{children}</>;

  return (
    <div className="app-main-surface flex h-full min-h-0 items-center justify-center px-4">
      <form className="flex w-full max-w-sm flex-col gap-3 rounded-md border bg-card p-5 shadow-sm" onSubmit={submit}>
        <div>
          <h1 className="text-base font-semibold">系统管理登录</h1>
          <p className="mt-1 text-sm text-muted-foreground">仅限系统管理员账号，用于管理所有租户。</p>
        </div>
        <Input autoFocus type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="邮箱" />
        <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={!email.trim() || !password || submitting}>
          {submitting ? '登录中…' : '登录'}
        </Button>
      </form>
    </div>
  );
}
