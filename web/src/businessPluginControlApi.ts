import type {
  BusinessPluginAdminView,
  BusinessPluginImportResponse,
  BusinessPluginMcpToolsView,
  BusinessPluginUninstallResponse,
  UpdateBusinessPluginSettingsInput,
} from '@runforge/contracts';
import { authFetch } from './api';
import { sysAdminAuthFetch } from './sysAdminApi';

export interface BusinessPluginControlApi {
  get(): Promise<BusinessPluginAdminView>;
  update(input: UpdateBusinessPluginSettingsInput): Promise<BusinessPluginAdminView>;
  reload(): Promise<BusinessPluginAdminView>;
  importArchive(file: File): Promise<BusinessPluginImportResponse>;
  uninstall(pluginId: string): Promise<BusinessPluginUninstallResponse>;
  loadMcpTools(pluginId: string, serverId: string): Promise<BusinessPluginMcpToolsView>;
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
    uninstall: (pluginId) => fetcher(`${base}/${encodeURIComponent(pluginId)}`, {
      method: 'DELETE',
    }).then(json<BusinessPluginUninstallResponse>),
    loadMcpTools: (pluginId, serverId) => fetcher(
      `${base}/${encodeURIComponent(pluginId)}/mcp/${encodeURIComponent(serverId)}/tools`,
      { method: 'POST' },
    ).then(json<BusinessPluginMcpToolsView>),
    importArchive: (file) => {
      const lowerName = file.name.toLowerCase();
      const format = lowerName.endsWith('.zip')
        ? 'zip'
        : lowerName.endsWith('.tgz') || lowerName.endsWith('.tar.gz')
          ? 'tgz'
          : null;
      if (!format) return Promise.reject(new Error('只支持 .zip、.tgz 和 .tar.gz 文件'));
      return fetcher(`${base}/import`, {
        method: 'POST',
        headers: {
          'Content-Type': format === 'zip' ? 'application/zip' : 'application/gzip',
          'X-RunForge-Archive-Format': format,
        },
        body: file,
      }).then(json<BusinessPluginImportResponse>);
    },
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
