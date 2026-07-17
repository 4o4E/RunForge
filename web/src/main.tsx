import React, { FormEvent, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { login, onAccessTokenInvalid, readAccessToken, restoreSession } from './api.js';
import { NotificationProvider } from './components/GlobalNotifications.js';
import { ShareFileView } from './components/ShareFileView.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { ThemeProvider } from './theme.js';
import './index.css';
import 'streamdown/styles.css';

const shareFileRoute = window.location.pathname === '/share/file';

type SessionStatus = 'restoring' | 'authenticated' | 'anonymous';

function LoginGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>(() => (readAccessToken() ? 'authenticated' : 'restoring'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status !== 'restoring') return;
    let canceled = false;
    // 页面刷新后 access token 只存在内存里、已经丢了;用持久化的 refresh token 静默换一个新的。
    void restoreSession().then((ok) => {
      if (!canceled) setStatus(ok ? 'authenticated' : 'anonymous');
    });
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
      await login(email.trim(), password);
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
          <h1 className="text-base font-semibold">登录 RunForge</h1>
          <p className="mt-1 text-sm text-muted-foreground">用租户账号邮箱和密码登录。</p>
        </div>
        <Input
          autoFocus
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="邮箱"
        />
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="密码"
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={!email.trim() || !password || submitting}>
          {submitting ? '登录中…' : '登录'}
        </Button>
      </form>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <NotificationProvider>
        {shareFileRoute ? (
          <ShareFileView />
        ) : (
          <LoginGate>
            <App />
          </LoginGate>
        )}
      </NotificationProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
