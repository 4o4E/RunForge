import type {
  BusinessPluginAdminView,
  UpdateBusinessPluginSettingsInput,
} from '@runforge/contracts';
import { authFetch } from './api';
import { sysAdminAuthFetch } from './sysAdminApi';

export interface BusinessPluginControlApi {
  get(): Promise<BusinessPluginAdminView>;
  update(input: UpdateBusinessPluginSettingsInput): Promise<BusinessPluginAdminView>;
  reload(): Promise<BusinessPluginAdminView>;
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

function createBusinessPluginControlApi(base: string, fetcher: Fetcher): BusinessPluginControlApi {
  return {
    get: () => fetcher(base).then(json<BusinessPluginAdminView>),
    update: (input) => fetcher(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then(json<BusinessPluginAdminView>),
    reload: () => fetcher(`${base}/reload`, { method: 'POST' }).then(json<BusinessPluginAdminView>),
  };
}

export function createTenantBusinessPluginControlApi(tenantId: string): BusinessPluginControlApi {
  return createBusinessPluginControlApi(
    `/api/tenants/${encodeURIComponent(tenantId)}/business-plugins`,
    authFetch,
  );
}

export function createSystemBusinessPluginControlApi(tenantId: string): BusinessPluginControlApi {
  return createBusinessPluginControlApi(
    `/api/system/tenants/${encodeURIComponent(tenantId)}/business-plugins`,
    sysAdminAuthFetch,
  );
}
