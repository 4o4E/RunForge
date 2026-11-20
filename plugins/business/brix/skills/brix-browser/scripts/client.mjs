import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class BrixError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const enc = encodeURIComponent;
const sessionPath = (id) => `/sessions/${enc(id)}`;
const filePath = (runId, name) => `/runs/${enc(runId)}/files${name === undefined ? '' : `/${enc(name)}`}`;

export class BrixClient {
  constructor(baseUrl, token) {
    if (!token?.trim()) throw new BrixError('missing_token');
    let url;
    try { url = new URL(baseUrl); } catch { throw new BrixError('invalid_api_url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new BrixError('invalid_api_url');
    }
    this.baseUrl = url.href.replace(/\/+$/, '');
    this.headers = { Authorization: `Bearer ${token.trim()}` };
  }

  async request(path, method = 'GET', body) {
    const stage = `${method} ${path}`;
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method, redirect: 'error', headers: body === undefined ? this.headers : { ...this.headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new BrixError('connection_error', { stage }); }
    if (response.ok) return response;
    const data = await response.json().catch(() => null);
    throw new BrixError(typeof data?.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : 'http_error', {
      status: response.status, stage, runId: data?.runId, downloads: data?.downloads, currentVersion: data?.currentVersion,
    });
  }

  async json(path, method = 'GET', body) {
    const response = await this.request(path, method, body);
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new BrixError('invalid_response', { stage: `${method} ${path}` }); }
  }

  async open(url) {
    const session = await this.json('/sessions', 'POST', url === undefined ? {} : { url });
    if (!session?.sessionId) throw new BrixError('invalid_session_response');
    return session;
  }

  async inSession(id, fn, url) {
    const sessionId = id ?? (await this.open(url)).sessionId;
    let error;
    try { return await fn(sessionId); }
    catch (cause) {
      error = cause instanceof BrixError ? cause : new BrixError('local_script_error');
      error.details.sessionId ??= sessionId;
      throw error;
    } finally {
      if (id === undefined) {
        try { await this.json(sessionPath(sessionId), 'DELETE'); }
        catch (cause) {
          if (!error) throw new BrixError('session_cleanup_failed', { sessionId, cause: cause.code });
          error.details.cleanupError = cause.code;
        }
      }
    }
  }

  async action(id, op, params = {}) {
    try { return await this.json(`${sessionPath(id)}/actions`, 'POST', { ...params, op }); }
    catch (error) {
      error.details.sessionId = id;
      error.details.stage = op;
      throw error;
    }
  }

  async run(id, name, args) {
    try {
      const result = await this.json(`${sessionPath(id)}/scripts/${enc(name)}`, 'POST', { args });
      if (!result?.runId || !Array.isArray(result.downloads)) {
        throw new BrixError('invalid_run_response');
      }
      return { ...result, output: result.output ?? null };
    } catch (error) {
      if (error.code === 'not_found') error.details.hint = '检查会话及部署的远程脚本；运行不会上传脚本。';
      throw error;
    }
  }

  put(name, source, language) { return this.json(`/scripts/${enc(name)}`, 'PUT', { source, language }); }
  files(runId) { return this.json(filePath(runId)); }

  async download(runId, name, destination) {
    const path = resolve(destination);
    const response = await this.request(filePath(runId, name));
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, '.brix-download-'));
    const pending = join(dir, 'download');
    try {
      const target = createWriteStream(pending);
      await pipeline(Readable.fromWeb(response.body), target);
      await rename(pending, path);
      return { path, bytes: target.bytesWritten };
    } catch { throw new BrixError('file_transfer_failed', { runId, path }); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

export function clientFromEnv(env = process.env) {
  const host = env.BRIX_HTTP_HOST?.trim() || '127.0.0.1';
  const address = host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return new BrixClient(env.BRIX_API_URL?.trim() || `http://${address}:${env.BRIX_HTTP_PORT?.trim() || '9233'}`, env.BRIX_TOKEN);
}

const mime = new Map(Object.entries({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf', txt: 'text/plain', json: 'application/json' }));

export async function localFile(path) {
  const bytes = await readFile(path).catch(() => { throw new BrixError('file_read_failed', { path }); });
  return { filename: basename(path), mimeType: mime.get(extname(path).slice(1).toLowerCase()) ?? 'application/octet-stream', base64: bytes.toString('base64') };
}

export async function saveScreenshot(path, response) {
  const result = response.result;
  if (typeof result?.base64 !== 'string' || !result.base64.length) throw new BrixError('invalid_screenshot_response', { runId: response.runId });
  const output = resolve(path);
  const bytes = Buffer.from(result.base64, 'base64');
  await writeFile(output, bytes).catch(() => { throw new BrixError('file_write_failed', { path: output, runId: response.runId }); });
  return { path: output, bytes: bytes.length, mimeType: result.mimeType, runId: response.runId };
}
