import React, { FormEvent, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { onAccessTokenInvalid, readAccessToken, writeAccessToken } from './api.js';
import { NotificationProvider } from './components/GlobalNotifications.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { ThemeProvider } from './theme.js';
import './index.css';
import 'streamdown/styles.css';

function AccessTokenGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(() => readAccessToken());
  const [draft, setDraft] = useState('');

  useEffect(() => onAccessTokenInvalid(() => {
    setToken('');
    setDraft('');
  }), []);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return;
    writeAccessToken(next);
    setToken(next);
  }

  if (token) return <>{children}</>;

  return (
    <div className="app-main-surface flex h-full min-h-0 items-center justify-center px-4">
      <form className="flex w-full max-w-sm flex-col gap-3 rounded-md border bg-card p-5 shadow-sm" onSubmit={submit}>
        <div>
          <h1 className="text-base font-semibold">输入访问 token</h1>
          <p className="mt-1 text-sm text-muted-foreground">Access token required. 访问 token 会通过 Header 发送给后端。</p>
        </div>
        <Input
          autoFocus
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="RUNFORGE_ACCESS_TOKEN"
        />
        <Button type="submit" disabled={!draft.trim()}>进入</Button>
      </form>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <NotificationProvider>
        <AccessTokenGate>
          <App />
        </AccessTokenGate>
      </NotificationProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
