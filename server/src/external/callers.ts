import { randomUUID } from 'node:crypto';
import type {
  CreateExternalCallerInput,
  CreateExternalCallerResponse,
  ExternalCallerSummary,
  ExternalTokenSummary,
} from '@runforge/contracts';
import { hashOpaqueToken } from '../auth/tokens.js';
import { spaceAccess, type SpaceActorContext } from '../spaces/access.js';
import { externalRepository } from './repository.js';
import { ExternalApiError, type ExternalRepository } from './types.js';

function nonEmpty(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ExternalApiError(400, 'INVALID_REQUEST', `${field} 为必填`);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function metadata(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalApiError(400, 'INVALID_REQUEST', 'metadata 必须是对象');
  }
  return value as Record<string, unknown>;
}

function expiration(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ExternalApiError(400, 'INVALID_REQUEST', 'expiresAt 必须是 ISO 时间或 null');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw new ExternalApiError(400, 'INVALID_REQUEST', 'expiresAt 必须是未来的有效时间');
  }
  return date.toISOString();
}

function newUuidToken(): { token: string; hash: string } {
  const token = randomUUID();
  return { token, hash: hashOpaqueToken(token) };
}

/** 外部调用方属于空间控制面；明文 UUID 只在签发响应中出现一次。 */
export class ExternalCallerService {
  constructor(private readonly repository: ExternalRepository = externalRepository) {}

  async create(actor: SpaceActorContext, spaceId: string, value: unknown): Promise<CreateExternalCallerResponse> {
    const space = await spaceAccess.requireManagedSpace(actor, spaceId);
    if (space.mode !== 'external') throw new ExternalApiError(409, 'SPACE_MODE_INVALID', '只有 external 空间可以创建调用方');
    const body = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Partial<CreateExternalCallerInput>;
    const issued = newUuidToken();
    const created = await this.repository.createCaller({
      tenantId: space.tenantId,
      spaceId,
      name: nonEmpty(body.name, 'name'),
      metadata: metadata(body.metadata),
      tokenHash: issued.hash,
      tokenLabel: optionalText(body.tokenLabel),
      tokenExpiresAt: expiration(body.tokenExpiresAt),
    });
    return { caller: created.caller, token: { ...created.tokens[0], token: issued.token } };
  }

  async list(actor: SpaceActorContext, spaceId: string) {
    const space = await spaceAccess.requireManagedSpace(actor, spaceId);
    if (space.mode !== 'external') throw new ExternalApiError(409, 'SPACE_MODE_INVALID', '只有 external 空间存在调用方');
    return this.repository.listCallers(space.tenantId, spaceId);
  }

  async update(actor: SpaceActorContext, spaceId: string, callerId: string, value: unknown): Promise<ExternalCallerSummary> {
    const space = await spaceAccess.requireManagedSpace(actor, spaceId);
    const body = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const fields: { name?: string; status?: 'active' | 'disabled'; metadata?: Record<string, unknown> } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'name')) fields.name = nonEmpty(body.name, 'name');
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        throw new ExternalApiError(400, 'INVALID_REQUEST', 'status 必须是 active 或 disabled');
      }
      fields.status = body.status;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'metadata')) fields.metadata = metadata(body.metadata);
    if (!Object.keys(fields).length) throw new ExternalApiError(400, 'INVALID_REQUEST', '缺少可更新字段');
    const updated = await this.repository.updateCaller({
      tenantId: space.tenantId, spaceId, callerId, ...fields,
    });
    if (!updated) throw new ExternalApiError(404, 'CALLER_NOT_FOUND', '调用方不存在');
    return updated;
  }

  async issueToken(
    actor: SpaceActorContext,
    spaceId: string,
    callerId: string,
    value: unknown,
  ): Promise<ExternalTokenSummary & { token: string }> {
    const space = await spaceAccess.requireManagedSpace(actor, spaceId);
    const body = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const issued = newUuidToken();
    const created = await this.repository.issueToken({
      tenantId: space.tenantId,
      spaceId,
      callerId,
      tokenHash: issued.hash,
      label: optionalText(body.label),
      expiresAt: expiration(body.expiresAt),
    });
    if (!created) throw new ExternalApiError(404, 'CALLER_NOT_FOUND', '调用方不存在');
    return { ...created, token: issued.token };
  }

  async revokeToken(actor: SpaceActorContext, spaceId: string, callerId: string, tokenId: string): Promise<ExternalTokenSummary> {
    const space = await spaceAccess.requireManagedSpace(actor, spaceId);
    const revoked = await this.repository.revokeToken(space.tenantId, spaceId, callerId, tokenId);
    if (!revoked) throw new ExternalApiError(404, 'TOKEN_NOT_FOUND', '外部 Token 不存在');
    return revoked;
  }
}

export const externalCallers = new ExternalCallerService();
