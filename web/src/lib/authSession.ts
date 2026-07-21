// 租户用户(web/src/api.ts)和系统管理员(web/src/sysAdminApi.ts)各自维护一套独立的
// token 存取/刷新逻辑，形状完全同构，只是端点路径、localStorage key、失效事件名不同。
// 这里抽出公共部分：拿到 token 之后怎么存、401 时怎么自动刷新重试一次、怎么恢复/登出。
// api.ts 现有的实现保持不动（已经在生产使用，不做风险性重构）；这个工厂只给新增的
// 系统管理员会话用。

export interface AuthSessionConfig {
  /** 静默换新 access token 的接口，请求体 {refreshToken} -> 响应体 {accessToken}。 */
  refreshPath: string;
  /** 吊销 refresh token 的接口，请求体 {refreshToken}。 */
  logoutPath: string;
  /** refresh token 持久化到 localStorage 的 key。 */
  storageKey: string;
  /** access token 失效（刷新也救不回来）时派发的全局事件名。 */
  invalidEventName: string;
}

export interface AuthSession {
  readAccessToken(): string;
  clearAccessToken(): void;
  onAccessTokenInvalid(listener: () => void): () => void;
  /** 页面刷新后调用：用持久化的 refreshToken 静默换一个新的 access token。 */
  restoreSession(): Promise<boolean>;
  logout(): Promise<void>;
  authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** 登录接口自己的请求/响应形状因调用方而异，这里只负责把拿到的 token 落进本会话的存储。 */
  applyLoginTokens(tokens: { accessToken: string; refreshToken: string }): void;
}

export function createAuthSession(config: AuthSessionConfig): AuthSession {
  let currentAccessToken = '';

  function setAccessToken(token: string): void {
    currentAccessToken = token;
  }

  function readAccessToken(): string {
    return currentAccessToken;
  }

  function readRefreshToken(): string {
    try {
      return window.localStorage.getItem(config.storageKey) ?? '';
    } catch {
      return '';
    }
  }

  function writeRefreshToken(token: string): void {
    try {
      window.localStorage.setItem(config.storageKey, token);
    } catch {
      // localStorage 不可用时，页面刷新后需要重新登录。
    }
  }

  function clearRefreshToken(): void {
    try {
      window.localStorage.removeItem(config.storageKey);
    } catch {
      // 清理失败只影响本地状态，不影响后端鉴权结果。
    }
  }

  function clearAccessToken(): void {
    setAccessToken('');
    clearRefreshToken();
  }

  function onAccessTokenInvalid(listener: () => void): () => void {
    window.addEventListener(config.invalidEventName, listener);
    return () => window.removeEventListener(config.invalidEventName, listener);
  }

  async function refreshAccessToken(refreshToken: string): Promise<boolean> {
    try {
      const res = await globalThis.fetch(config.refreshPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearAccessToken();
        return false;
      }
      const body = (await res.json()) as { accessToken: string };
      setAccessToken(body.accessToken);
      return true;
    } catch {
      return false;
    }
  }

  async function restoreSession(): Promise<boolean> {
    const refreshToken = readRefreshToken();
    if (!refreshToken) return false;
    return refreshAccessToken(refreshToken);
  }

  async function logout(): Promise<void> {
    const refreshToken = readRefreshToken();
    clearAccessToken();
    if (!refreshToken) return;
    try {
      await globalThis.fetch(config.logoutPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // 登出请求失败不影响本地已清空的登录态；服务端 refresh token 会自然过期。
    }
  }

  function authHeaders(headers?: HeadersInit): Headers {
    const next = new Headers(headers);
    const token = readAccessToken();
    if (token) next.set('Authorization', `Bearer ${token}`);
    return next;
  }

  function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    return globalThis.fetch(input, { ...init, headers: authHeaders(init.headers) }).then(async (res) => {
      if (res.status !== 401) return res;
      const refreshToken = readRefreshToken();
      if (!refreshToken || !(await refreshAccessToken(refreshToken))) {
        clearAccessToken();
        window.dispatchEvent(new Event(config.invalidEventName));
        return res;
      }
      // 静默换新成功，用新 access token 重试一次原请求。
      return globalThis.fetch(input, { ...init, headers: authHeaders(init.headers) });
    });
  }

  function applyLoginTokens(tokens: { accessToken: string; refreshToken: string }): void {
    setAccessToken(tokens.accessToken);
    writeRefreshToken(tokens.refreshToken);
  }

  return { readAccessToken, clearAccessToken, onAccessTokenInvalid, restoreSession, logout, authFetch, applyLoginTokens };
}
