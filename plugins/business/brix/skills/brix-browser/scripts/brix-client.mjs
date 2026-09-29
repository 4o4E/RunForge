function detail(body, fallback) {
  if (body && typeof body === 'object') return JSON.stringify(body);
  return typeof body === 'string' && body ? body : fallback;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Brix HTTP SDK。通用浏览器任务显式管理 session；独立服务端脚本可使用 runScript 的临时 session。
 */
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

  async json(path, init, action) {
    const response = await this.request(path, init);
    const body = await responseBody(response);
    if (!response.ok) {
      throw new Error(`${action}失败：HTTP ${response.status} ${detail(body, response.statusText)}`);
    }
    return body;
  }

  async listScripts() {
    return this.json('/scripts', {}, '读取 Brix 脚本列表');
  }

  async getScript(name) {
    return this.json(`/scripts/${encodeURIComponent(name)}`, {}, `读取 Brix 脚本 ${name}`);
  }

  async ensureScript(name, source, language = 'js') {
    const existing = await this.request(`/scripts/${encodeURIComponent(name)}`);
    if (existing.ok) {
      await existing.arrayBuffer();
      return false;
    }
    if (existing.status !== 404) {
      throw new Error(`读取 Brix 脚本失败：HTTP ${existing.status} ${detail(await responseBody(existing), existing.statusText)}`);
    }
    await existing.arrayBuffer();
    await this.json(`/scripts/${encodeURIComponent(name)}`, {
      method: 'PUT', body: JSON.stringify({ source, language }),
    }, `保存 Brix 脚本 ${name}`);
    return true;
  }

  async createSession(url) {
    const body = await this.json('/sessions', {
      method: 'POST', body: JSON.stringify(url ? { url } : {}),
    }, '创建 Brix session');
    if (!body?.sessionId) throw new Error('创建 Brix session 的响应缺少 sessionId');
    return body;
  }

  async listSessions() {
    return this.json('/sessions', {}, '读取 Brix session 列表');
  }

  async closeSession(sessionId) {
    const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!response.ok) {
      throw new Error(`关闭 Brix session 失败：HTTP ${response.status} ${detail(await responseBody(response), response.statusText)}`);
    }
    await response.arrayBuffer();
  }

  async action(sessionId, input) {
    return this.json(`/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: 'POST', body: JSON.stringify(input),
    }, `执行 Brix 浏览器操作 ${input.op ?? ''}`.trim());
  }

  async trace(sessionId) {
    return this.json(`/sessions/${encodeURIComponent(sessionId)}/trace`, {}, '读取 Brix session 操作轨迹');
  }

  async runScriptInSession(sessionId, name, args) {
    const body = await this.json(`/sessions/${encodeURIComponent(sessionId)}/scripts/${encodeURIComponent(name)}`, {
      method: 'POST', body: JSON.stringify({ args }),
    }, `执行 Brix 脚本 ${name}`);
    if (!body?.runId || !Object.hasOwn(body, 'output')) {
      throw new Error(`Brix 脚本 ${name} 的响应缺少 runId 或 output`);
    }
    return body;
  }

  async runScript(name, args, options = {}) {
    const session = await this.createSession(options.url);
    try {
      return await this.runScriptInSession(session.sessionId, name, args);
    } finally {
      await this.closeSession(session.sessionId);
    }
  }

  async listRunFiles(runId) {
    return this.json(`/runs/${encodeURIComponent(runId)}/files`, {}, '读取 Brix 下载产物列表');
  }

  async downloadRunFile(runId, name) {
    const response = await this.request(`/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(name)}`);
    if (!response.ok) {
      throw new Error(`读取 Brix 下载产物失败：HTTP ${response.status} ${detail(await responseBody(response), response.statusText)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
