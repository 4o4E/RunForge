function detail(body, fallback) {
  if (body && typeof body === 'object') return JSON.stringify(body);
  return typeof body === 'string' && body ? body : fallback;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** Brix HTTP SDK：提供鉴权请求、脚本恢复和临时 session 生命周期。 */
export class BrixClient {
  constructor(baseUrl, token, fetchImpl = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    if (!this.baseUrl) throw new Error('Brix base URL 不能为空');
    if (!token.trim()) throw new Error('Brix token 不能为空');
    this.token = token.trim();
    this.fetchImpl = fetchImpl;
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
  }

  async ensureScript(name, source, language = 'ts') {
    const existing = await this.request(`/scripts/${encodeURIComponent(name)}`);
    if (existing.ok) {
      await existing.arrayBuffer();
      return false;
    }
    if (existing.status !== 404) {
      throw new Error(`读取 Brix 脚本失败：HTTP ${existing.status} ${detail(await responseBody(existing), existing.statusText)}`);
    }
    await existing.arrayBuffer();
    const saved = await this.request(`/scripts/${encodeURIComponent(name)}`, {
      method: 'PUT', body: JSON.stringify({ source, language }),
    });
    if (!saved.ok) {
      throw new Error(`保存 Brix 脚本失败：HTTP ${saved.status} ${detail(await responseBody(saved), saved.statusText)}`);
    }
    await saved.arrayBuffer();
    return true;
  }

  async runScript(name, args) {
    const created = await this.request('/sessions', { method: 'POST', body: '{}' });
    const createdBody = await responseBody(created);
    if (!created.ok || !createdBody?.sessionId) {
      throw new Error(`创建 Brix session 失败：HTTP ${created.status} ${detail(createdBody, created.statusText)}`);
    }
    const sessionId = createdBody.sessionId;
    try {
      const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}/scripts/${encodeURIComponent(name)}`, {
        method: 'POST', body: JSON.stringify({ args }),
      });
      const body = await responseBody(response);
      if (!response.ok) {
        throw new Error(`执行 Brix 脚本失败：HTTP ${response.status} ${detail(body, response.statusText)}`);
      }
      if (!body?.runId || !body?.output) throw new Error('Brix 脚本响应缺少 runId 或 output');
      return body.output;
    } finally {
      await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}
