import { Router } from 'express';
import type { Request } from 'express';
import type { RuntimeCapabilitiesSettings, RuntimeCapabilityCredential, RuntimeCapabilityName, RuntimeImageCapabilityModel } from '@runforge/contracts';
import {
  DATASOURCE_CREDENTIAL_CAPABILITY,
  DatasourceError,
  tokenAllowsCapability,
  validateWorkloadToken,
} from '../datasources/accountPool.js';
import { getConfiguredProvider } from '../llm/index.js';
import type { LlmMessage, LlmUsage } from '../llm/types.js';
import { query } from '../db/pool.js';
import { newRuntimeCapabilityCallId } from '../id.js';
import { getRuntimeCapabilitiesSettings } from '../settings.js';
import { store } from '../store/index.js';
import { scopeForThread, type Scope } from '../store/types.js';
import { providerRunner } from '../llm/providerRunner.js';

export const runtimeCapabilitiesApi = Router();

type CallStatus = 'success' | 'error';

const CAPABILITY_ENDPOINTS: Record<RuntimeCapabilityName, Record<string, string>> = {
  'datasource.credentials': {
    credentials: '/api/runtime/datasources/{datasourceId}/credentials',
  },
  llm: {
    chat: '/api/runtime-capabilities/llm/chat',
    responses: '/api/runtime-capabilities/llm/responses',
  },
  image: {
    generate: '/api/runtime-capabilities/images/generate',
    edit: '/api/runtime-capabilities/images/edit',
  },
  video: {
    generate: '/api/runtime-capabilities/videos/generate',
  },
};

function bearerToken(header: unknown): string {
  const value = typeof header === 'string' ? header : '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) throw new DatasourceError(401, '缺少 Authorization: Bearer <WORKLOAD_TOKEN>');
  return match[1].trim();
}

function handleError(res: import('express').Response, err: unknown) {
  if (err instanceof DatasourceError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: (err as Error).message });
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truncate(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function requestedModelId(body: Record<string, unknown>): string | undefined {
  return optionalString(body.modelId) ?? optionalString(body.model);
}

async function scopeForRunId(runId: string): Promise<Scope> {
  const run = await store.getRunUnscoped(runId);
  if (!run) throw new DatasourceError(404, 'run 不存在');
  const thread = await store.getThreadUnscoped(run.thread_id);
  if (!thread) throw new DatasourceError(404, 'thread 不存在');
  try {
    return scopeForThread(thread);
  } catch {
    throw new DatasourceError(404, 'run 不存在');
  }
}

async function loadSettingsAndEnsureEnabled(scope: Scope, capability: RuntimeCapabilityName): Promise<Awaited<ReturnType<typeof getRuntimeCapabilitiesSettings>> | null> {
  if (capability === DATASOURCE_CREDENTIAL_CAPABILITY) return null;
  const settings = await getRuntimeCapabilitiesSettings(scope);
  if (capability === 'llm' && settings.llm.enabled) return settings;
  if (capability === 'image' && settings.image.enabled) return settings;
  if (capability === 'video' && settings.video.enabled) return settings;
  throw new DatasourceError(403, `运行时能力未启用：${capability}`);
}

async function runtimeBaseUrl(): Promise<string> {
  return (process.env.RUNFORGE_RUNTIME_API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8080}/api/runtime`).replace(/\/api\/runtime\/?$/, '');
}

async function identifyWorkloadRequest(req: Request): Promise<{ token: string; tokenId: string; runId: string; scope: Scope; expiresAt: string; allowedCapabilities: RuntimeCapabilityName[] }> {
  const token = bearerToken(req.headers.authorization);
  const validated = await validateWorkloadToken(token);
  const scope = await scopeForRunId(validated.token.run_id);
  return {
    token,
    tokenId: validated.token.id,
    runId: validated.token.run_id,
    scope,
    expiresAt: validated.token.expires_at,
    allowedCapabilities: validated.token.allowed_capabilities,
  };
}

async function auditStepId(req: Request, runId: string): Promise<string | null> {
  const raw = optionalString(req.headers['x-runforge-step-id']);
  if (!raw) return null;
  const { rows } = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM steps WHERE id = $1 AND run_id = $2`,
    [raw, runId],
  );
  return rows.length ? raw : null;
}

async function requireCapabilityEnabled(
  identified: Awaited<ReturnType<typeof identifyWorkloadRequest>>,
  capability: RuntimeCapabilityName,
): Promise<RuntimeCapabilitiesSettings | null> {
  if (!identified.allowedCapabilities.includes(capability)) throw new DatasourceError(403, `WORKLOAD_TOKEN 无权使用运行时能力：${capability}`);
  return loadSettingsAndEnsureEnabled(identified.scope, capability);
}

async function addCapabilityAudit(input: {
  scope: Scope;
  runId: string;
  stepId?: string | null;
  tokenId?: string | null;
  capability: RuntimeCapabilityName;
  provider?: string | null;
  model?: string | null;
  requestSummary?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  usage?: LlmUsage | Record<string, unknown> | null;
  status: CallStatus;
  error?: string | null;
  startedAt: Date;
  endedAt?: Date;
}): Promise<void> {
  await query(
    `INSERT INTO runtime_capability_calls (
       id, tenant_id, run_id, step_id, token_id, capability, provider, model,
       request_summary, response_summary, usage, status, error, started_at, ended_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15)`,
    [
      newRuntimeCapabilityCallId(),
      input.scope.tenantId,
      input.runId,
      input.stepId ?? null,
      input.tokenId ?? null,
      input.capability,
      input.provider ?? null,
      input.model ?? null,
      JSON.stringify(input.requestSummary ?? {}),
      JSON.stringify(input.responseSummary ?? {}),
      input.usage ? JSON.stringify(input.usage) : null,
      input.status,
      input.error ?? null,
      input.startedAt,
      input.endedAt ?? new Date(),
    ],
  );
}

function normalizeCapability(value: unknown): RuntimeCapabilityName {
  if (value === 'datasource.credentials' || value === 'llm' || value === 'image' || value === 'video') return value;
  throw new DatasourceError(400, 'capability 必须是 datasource.credentials / llm / image / video');
}

function publicModelsForCredential(capability: RuntimeCapabilityName, settings: RuntimeCapabilitiesSettings | null): Record<string, unknown>[] {
  if (!settings) return [];
  if (capability === 'llm') return settings.llm.models.map((model) => ({ id: model.id, label: model.label }));
  if (capability === 'image') return settings.image.models.map((model) => ({ id: model.id, label: model.label, provider: model.provider, model: model.model }));
  if (capability === 'video') return settings.video.models.map((model) => ({ id: model.id, label: model.label, provider: model.provider, model: model.model }));
  return [];
}

function defaultModelIdForCapability(capability: RuntimeCapabilityName, settings: RuntimeCapabilitiesSettings | null): string | undefined {
  if (!settings) return undefined;
  if (capability === 'llm') return settings.llm.defaultModelId || undefined;
  if (capability === 'image') return settings.image.defaultModelId || undefined;
  if (capability === 'video') return settings.video.defaultModelId || undefined;
  return undefined;
}

async function credentialFor(capability: RuntimeCapabilityName, token: string, expiresAt: string, settings: RuntimeCapabilitiesSettings | null, stepId?: string | null): Promise<RuntimeCapabilityCredential> {
  const base = await runtimeBaseUrl();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (stepId) headers['X-RunForge-Step-Id'] = stepId;
  const defaultModelId = defaultModelIdForCapability(capability, settings);
  return {
    capability,
    baseUrl: base,
    headers,
    expiresAt,
    endpoints: CAPABILITY_ENDPOINTS[capability],
    defaults: {
      ...(defaultModelId ? { model: defaultModelId } : {}),
      ...(capability === 'image' ? { n: 1 } : {}),
    },
    models: publicModelsForCredential(capability, settings),
  };
}

function normalizeMessages(value: unknown): LlmMessage[] {
  if (!Array.isArray(value)) throw new DatasourceError(400, 'messages 必须是数组');
  return value.map((item) => {
    const row = jsonObject(item);
    const role = row.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new DatasourceError(400, 'message.role 必须是 system/user/assistant/tool');
    }
    return { role, content: typeof row.content === 'string' ? row.content : '' };
  });
}

function summarizeMessages(messages: LlmMessage[]): Record<string, unknown> {
  return {
    count: messages.length,
    chars: messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0),
    first: messages[0]?.content ? truncate(messages[0].content, 120) : '',
  };
}

runtimeCapabilitiesApi.post('/credentials', async (req, res) => {
  const startedAt = new Date();
  let audit: { scope: Scope; runId: string; tokenId: string; capability: RuntimeCapabilityName } | null = null;
  let stepId: string | null = null;
  try {
    const capability = normalizeCapability(req.body?.capability);
    const token = bearerToken(req.headers.authorization);
    const validated = await validateWorkloadToken(token);
    audit = {
      scope: await scopeForRunId(validated.token.run_id),
      runId: validated.token.run_id,
      tokenId: validated.token.id,
      capability,
    };
    stepId = await auditStepId(req, audit.runId);
    if (!tokenAllowsCapability(validated.token, capability)) throw new DatasourceError(403, `WORKLOAD_TOKEN 无权使用运行时能力：${capability}`);
    const settings = await loadSettingsAndEnsureEnabled(audit.scope, capability);
    const credential = await credentialFor(capability, token, validated.token.expires_at, settings, stepId);
    await addCapabilityAudit({
      ...audit,
      stepId,
      requestSummary: { capability },
      responseSummary: { endpoints: Object.keys(credential.endpoints) },
      status: 'success',
      startedAt,
    });
    res.json(credential);
  } catch (err) {
    if (audit) {
      await addCapabilityAudit({
        ...audit,
        stepId,
        requestSummary: { capability: audit.capability },
        status: 'error',
        error: (err as Error).message,
        startedAt,
      }).catch(() => {});
    }
    handleError(res, err);
  }
});

async function handleLlmChat(req: Request, res: import('express').Response, bodyOverride?: unknown) {
  const startedAt = new Date();
  let audit: Awaited<ReturnType<typeof identifyWorkloadRequest>> | null = null;
  let stepId: string | null = null;
  let modelRef: string | undefined;
  try {
    audit = await identifyWorkloadRequest(req);
    stepId = await auditStepId(req, audit.runId);
    const body = jsonObject(bodyOverride ?? req.body);
    const settings = await requireCapabilityEnabled(audit, 'llm');
    const selected = selectLlmModel(settings, body);
    modelRef = selected.modelRef;
    const messages = normalizeMessages(body.messages);
    const configured = await getConfiguredProvider(audit.scope, modelRef);
    const run = await store.getRun(audit.scope, audit.runId);
    const thread = run ? await store.getThread(audit.scope, run.thread_id) : null;
    if (!run || !thread) throw new DatasourceError(404, 'run 不存在');
    const result = await providerRunner.run({
      provider: configured.provider,
      context: {
        tenantId: audit.scope.tenantId,
        spaceId: thread.space_id,
        threadId: thread.id,
        runId: run.id,
        stepId,
        purpose: 'runtime-capability',
        ...configured.descriptor,
      },
      messages,
      tools: [],
    });
    await addCapabilityAudit({
      scope: audit.scope,
      runId: audit.runId,
      stepId,
      tokenId: audit.tokenId,
      capability: 'llm',
      provider: configured.provider.name,
      model: configured.modelRef,
      requestSummary: { modelId: selected.id, modelRef, messages: summarizeMessages(messages) },
      responseSummary: { contentChars: result.content?.length ?? 0, toolCalls: result.toolCalls.length, finishReason: result.finishReason },
      usage: result.usage ?? null,
      status: 'success',
      startedAt,
    });
    res.json(result);
  } catch (err) {
    if (audit) {
      await addCapabilityAudit({
        scope: audit.scope,
        runId: audit.runId,
        stepId,
        tokenId: audit.tokenId,
        capability: 'llm',
        model: modelRef ?? null,
        status: 'error',
        error: (err as Error).message,
        startedAt,
      }).catch(() => {});
    }
    handleError(res, err);
  }
}

runtimeCapabilitiesApi.post('/llm/chat', (req, res) => void handleLlmChat(req, res));

runtimeCapabilitiesApi.post('/llm/responses', async (req, res) => {
  const body = jsonObject(req.body);
  const input = typeof body.input === 'string' ? body.input : JSON.stringify(body.input ?? '');
  await handleLlmChat(req, res, { model: requestedModelId(body), messages: [{ role: 'user', content: input }] });
});

function selectLlmModel(settings: RuntimeCapabilitiesSettings | null, body: Record<string, unknown>): { id: string; modelRef: string } {
  if (!settings) throw new DatasourceError(500, 'LLM 能力配置缺失');
  const id = requestedModelId(body) ?? settings.llm.defaultModelId;
  const selected = settings.llm.models.find((model) => model.id === id);
  if (!selected) throw new DatasourceError(400, `运行时 LLM 模型未配置：${id || 'default'}`);
  return { id: selected.id, modelRef: selected.modelRef };
}

function selectImageModel(settings: RuntimeCapabilitiesSettings, body: Record<string, unknown>): RuntimeImageCapabilityModel {
  const id = requestedModelId(body) ?? settings.image.defaultModelId;
  const selected = settings.image.models.find((model) => model.id === id);
  if (!selected) throw new DatasourceError(400, `图片模型未配置：${id || 'default'}`);
  return selected;
}

async function proxyPackyImage(
  req: Request,
  mode: 'generate' | 'edit',
  settings: RuntimeCapabilitiesSettings,
): Promise<{ status: number; body: unknown; model: RuntimeImageCapabilityModel }> {
  const body = jsonObject(req.body);
  const image = selectImageModel(settings, body);
  if (!image.apiKey.trim()) throw new DatasourceError(400, `图片生成能力未配置 apiKey：${image.id}`);
  const { model: _modelSelector, modelId: _modelId, ...passthrough } = body;
  const payload: Record<string, unknown> = { ...passthrough, model: image.model };
  if (typeof payload.n === 'number' && payload.n !== 1) throw new DatasourceError(400, 'gpt-image-2 当前只支持 n=1');
  const endpoint = mode === 'generate' ? '/v1/images/generations' : '/v1/images/edits';
  const headers: Record<string, string> = { Authorization: `Bearer ${image.apiKey}` };
  let upstreamBody: string;
  if (mode === 'edit' && req.is('multipart/form-data')) {
    throw new DatasourceError(400, 'image edit multipart 代理暂未启用，请使用 JSON/base64 输入或后续接入文件转发');
  }
  headers['Content-Type'] = 'application/json';
  upstreamBody = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), image.timeoutMs);
  try {
    const response = await fetch(`${image.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
      method: 'POST',
      headers,
      body: upstreamBody,
      signal: ctrl.signal,
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { text };
    }
    return { status: response.status, body: parsed, model: image };
  } finally {
    clearTimeout(timer);
  }
}

async function imageRoute(req: Request, res: import('express').Response, mode: 'generate' | 'edit') {
  const startedAt = new Date();
  let audit: Awaited<ReturnType<typeof identifyWorkloadRequest>> | null = null;
  let settings: RuntimeCapabilitiesSettings | null = null;
  let selectedImageModel: RuntimeImageCapabilityModel | null = null;
  let stepId: string | null = null;
  try {
    audit = await identifyWorkloadRequest(req);
    stepId = await auditStepId(req, audit.runId);
    settings = await requireCapabilityEnabled(audit, 'image');
    if (!settings) throw new DatasourceError(500, '图片生成能力配置缺失');
    const proxied = await proxyPackyImage(req, mode, settings);
    selectedImageModel = proxied.model;
    await addCapabilityAudit({
      scope: audit.scope,
      runId: audit.runId,
      stepId,
      tokenId: audit.tokenId,
      capability: 'image',
      provider: proxied.model.provider,
      model: proxied.model.model,
      requestSummary: { mode, modelId: proxied.model.id, keys: Object.keys(jsonObject(req.body)) },
      responseSummary: { status: proxied.status },
      status: proxied.status >= 200 && proxied.status < 400 ? 'success' : 'error',
      error: proxied.status >= 400 ? JSON.stringify(proxied.body).slice(0, 500) : null,
      startedAt,
    });
    res.status(proxied.status).json(proxied.body);
  } catch (err) {
    if (audit) {
      await addCapabilityAudit({
        scope: audit.scope,
        runId: audit.runId,
        stepId,
        tokenId: audit.tokenId,
        capability: 'image',
        provider: selectedImageModel?.provider ?? null,
        model: selectedImageModel?.model ?? null,
        requestSummary: { mode },
        status: 'error',
        error: (err as Error).message,
        startedAt,
      }).catch(() => {});
    }
    handleError(res, err);
  }
}

runtimeCapabilitiesApi.post('/images/generate', (req, res) => void imageRoute(req, res, 'generate'));
runtimeCapabilitiesApi.post('/images/edit', (req, res) => void imageRoute(req, res, 'edit'));

runtimeCapabilitiesApi.post('/videos/generate', async (req, res) => {
  const startedAt = new Date();
  let audit: Awaited<ReturnType<typeof identifyWorkloadRequest>> | null = null;
  let stepId: string | null = null;
  try {
    audit = await identifyWorkloadRequest(req);
    stepId = await auditStepId(req, audit.runId);
    await requireCapabilityEnabled(audit, 'video');
    throw new DatasourceError(501, '视频生成能力尚未接入 provider');
  } catch (err) {
    if (audit) {
      await addCapabilityAudit({
        scope: audit.scope,
        runId: audit.runId,
        stepId,
        tokenId: audit.tokenId,
        capability: 'video',
        status: 'error',
        error: (err as Error).message,
        startedAt,
      }).catch(() => {});
    }
    handleError(res, err);
  }
});
