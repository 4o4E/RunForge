import React, { FormEvent, useEffect, useState } from 'react';
import { getCurrentUser, loginWithRoleGuard, onAccessTokenInvalid, restoreSession } from '../api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// /admin 和 / 是同一套 scope:'tenant' 会话(共用 api.ts 的 token 存储)，只是登录成功后
// 多一道角色校验(设计决策 1、2，见 /root/.claude/plans/groovy-snuggling-whistle.md)。
// 'forbidden' 态专门给"页面刷新时用共享 refresh token 恢复了会话，但角色不是
// owner/admin"这种情况——这时绝不能调用 logout()，会把用户在 / 标签页的正常会话顶掉。

type AdminSessionStatus = 'restoring' | 'anonymous' | 'forbidden' | 'authenticated';

export function AdminLoginGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AdminSessionStatus>('restoring');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status !== 'restoring') return;
    let canceled = false;
    void (async () => {
      const restored = await restoreSession();
      if (canceled) return;
      if (!restored) {
        setStatus('anonymous');
        return;
      }
      try {
        const user = await getCurrentUser();
        if (canceled) return;
        setStatus(user.role === 'owner' || user.role === 'admin' ? 'authenticated' : 'forbidden');
      } catch {
        // 角色校验请求失败(比如网络抖动):回到匿名态允许重试，不调用 logout()——
        // 这里用的是共享 refresh token，不能因为一次请求失败就把它撤销。
        if (!canceled) setStatus('anonymous');
      }
    })();
    return () => {
      canceled = true;
    };
  }, [status]);

  useEffect(() => onAccessTokenInvalid(() => {
    setStatus('anonymous');
    setPassword('');
  }), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      // loginWithRoleGuard 只有角色校验通过才会把 token 写进共享存储；角色不对时
      // 服务端登出这次刚签发的 token，全程不触碰共享 localStorage 里可能属于
      // 其它标签页正常会话的旧值(见 api.ts 的注释)。
      const result = await loginWithRoleGuard(
        email.trim(),
        password,
        tenantId.trim() || undefined,
        (role) => role === 'owner' || role === 'admin',
      );
      if (result.ok) {
        setStatus('authenticated');
        setPassword('');
      } else {
        setError('该账号不是管理员，请从普通入口登录');
      }
    } catch (err) {
      setError((err as Error).message || '登录失败');
    } finally {
      setSubmitting(false);
    }
  }

  if (status === 'restoring') return null;
  if (status === 'authenticated') return <>{children}</>;

  if (status === 'forbidden') {
    return (
      <div className="app-main-surface flex h-full min-h-0 items-center justify-center px-4">
        <div className="flex w-full max-w-sm flex-col gap-3 rounded-md border bg-card p-5 text-sm shadow-sm">
          <h1 className="text-base font-semibold">无管理员权限</h1>
          <p className="text-muted-foreground">当前登录账号不是 owner 或 admin，不能访问管理后台。</p>
          <a className="text-primary underline underline-offset-2" href="/">返回普通入口</a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-main-surface flex h-full min-h-0 items-center justify-center px-4">
      <form className="flex w-full max-w-sm flex-col gap-3 rounded-md border bg-card p-5 shadow-sm" onSubmit={submit}>
        <div>
          <h1 className="text-base font-semibold">管理后台登录</h1>
          <p className="mt-1 text-sm text-muted-foreground">仅限租户 owner / admin 账号。</p>
        </div>
        <Input autoFocus type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="邮箱" />
        <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" />
        <Input value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="租户 ID（留空使用 default）" />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={!email.trim() || !password || submitting}>
          {submitting ? '登录中…' : '登录'}
        </Button>
      </form>
    </div>
  );
}
