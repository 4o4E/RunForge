import type {
  CreateExternalCallerInput,
  CreateExternalCallerResponse,
  CreateSpaceInput,
  ExternalCallerSummary,
  ExternalTokenSummary,
  PromptPlaceholdersView,
  SpaceOptions,
  SpaceSummary,
  TenantUserSummary,
  UpdateSpaceInput,
} from '@runforge/contracts';
import { authFetch, listTenantUsers } from './api';
import { listSystemTenantUsers, sysAdminAuthFetch } from './sysAdminApi';

export interface ExternalCallerWithTokens {
  caller: ExternalCallerSummary;
  tokens: ExternalTokenSummary[];
}

export interface SpaceControlApi {
  listSpaces(includeDeleted?: boolean): Promise<{ spaces: SpaceSummary[] }>;
  getSpace(spaceId: string): Promise<SpaceSummary>;
  getOptions(): Promise<SpaceOptions>;
  getPromptPlaceholders(spaceId: string): Promise<PromptPlaceholdersView>;
  listUsers(): Promise<{ users: TenantUserSummary[] }>;
  createSpace(input: CreateSpaceInput): Promise<SpaceSummary>;
  updateSpace(spaceId: string, input: UpdateSpaceInput): Promise<SpaceSummary>;
  deleteSpace(spaceId: string): Promise<SpaceSummary>;
  restoreSpace(spaceId: string): Promise<SpaceSummary>;
  listCallers(spaceId: string): Promise<{ callers: ExternalCallerWithTokens[] }>;
  createCaller(spaceId: string, input: CreateExternalCallerInput): Promise<CreateExternalCallerResponse>;
  updateCaller(
    spaceId: string,
    callerId: string,
    input: { name?: string; status?: 'active' | 'disabled'; metadata?: Record<string, unknown> },
  ): Promise<ExternalCallerSummary>;
  issueToken(
    spaceId: string,
    callerId: string,
    input: { label?: string | null; expiresAt?: string | null },
  ): Promise<ExternalTokenSummary & { token: string }>;
  revokeToken(spaceId: string, callerId: string, tokenId: string): Promise<ExternalTokenSummary>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = '';
    try {
      detail = ((await response.json()) as { error?: string }).error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail ? `${response.status} ${detail}` : `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function body(method: 'POST' | 'PATCH', value?: unknown): RequestInit {
  return {
    method,
    ...(value === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    }),
  };
}

function createSpaceControlApi(
  base: string,
  fetcher: Fetcher,
  listUsers: () => Promise<{ users: TenantUserSummary[] }>,
): SpaceControlApi {
  const path = (suffix = '') => `${base}${suffix}`;
  return {
    listSpaces: (includeDeleted = true) => fetcher(path(includeDeleted ? '?includeDeleted=1' : ''))
      .then(json<{ spaces: SpaceSummary[] }>),
    getSpace: (spaceId) => fetcher(path(`/${encodeURIComponent(spaceId)}`)).then(json<SpaceSummary>),
    getOptions: () => fetcher(path('/options')).then(json<SpaceOptions>),
    getPromptPlaceholders: (spaceId) => fetcher(path(`/${encodeURIComponent(spaceId)}/prompt-placeholders`))
      .then(json<PromptPlaceholdersView>),
    listUsers,
    createSpace: (input) => fetcher(path(), body('POST', input)).then(json<SpaceSummary>),
    updateSpace: (spaceId, input) => fetcher(path(`/${encodeURIComponent(spaceId)}`), body('PATCH', input)).then(json<SpaceSummary>),
    deleteSpace: (spaceId) => fetcher(path(`/${encodeURIComponent(spaceId)}`), { method: 'DELETE' }).then(json<SpaceSummary>),
    restoreSpace: (spaceId) => fetcher(path(`/${encodeURIComponent(spaceId)}/restore`), body('POST')).then(json<SpaceSummary>),
    listCallers: (spaceId) => fetcher(path(`/${encodeURIComponent(spaceId)}/callers`))
      .then(json<{ callers: ExternalCallerWithTokens[] }>),
    createCaller: (spaceId, input) => fetcher(path(`/${encodeURIComponent(spaceId)}/callers`), body('POST', input))
      .then(json<CreateExternalCallerResponse>),
    updateCaller: (spaceId, callerId, input) => fetcher(
      path(`/${encodeURIComponent(spaceId)}/callers/${encodeURIComponent(callerId)}`),
      body('PATCH', input),
    ).then(json<ExternalCallerSummary>),
    issueToken: (spaceId, callerId, input) => fetcher(
      path(`/${encodeURIComponent(spaceId)}/callers/${encodeURIComponent(callerId)}/tokens`),
      body('POST', input),
    ).then(json<ExternalTokenSummary & { token: string }>),
    revokeToken: (spaceId, callerId, tokenId) => fetcher(
      path(`/${encodeURIComponent(spaceId)}/callers/${encodeURIComponent(callerId)}/tokens/${encodeURIComponent(tokenId)}`),
      { method: 'DELETE' },
    ).then(json<ExternalTokenSummary>),
  };
}

export function createTenantSpaceControlApi(tenantId: string): SpaceControlApi {
  return createSpaceControlApi('/api/spaces', authFetch, () => listTenantUsers(tenantId));
}

export function createSystemSpaceControlApi(tenantId: string): SpaceControlApi {
  return createSpaceControlApi(
    `/api/system/tenants/${encodeURIComponent(tenantId)}/spaces`,
    sysAdminAuthFetch,
    () => listSystemTenantUsers(tenantId),
  );
}
