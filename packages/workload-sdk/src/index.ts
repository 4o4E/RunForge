import type {
  PublicCredentialResponse,
  RuntimeCapabilityCredential,
  WorkloadResourceType,
  WorkloadSecretResponse,
} from '@runforge/contracts';

export type { WorkloadResourceType } from '@runforge/contracts';

export interface WorkloadClientOptions {
  token?: string;
  runtimeApiBase?: string;
  stepId?: string;
  fetch?: typeof globalThis.fetch;
}

export interface DatabaseReadonlyAcquireOptions {
  /** 可省略并使用 run 注入的 DATASOURCE_ID。 */
  datasourceId?: string;
  /** 只能指向服务端标记为 readonly 的权限档位。 */
  profile?: string;
}

export type WorkloadResourceResult<T extends WorkloadResourceType> =
  T extends 'database.readonly' ? PublicCredentialResponse : RuntimeCapabilityCredential;

export type WorkloadResourceOptions<T extends WorkloadResourceType> =
  T extends 'database.readonly' ? DatabaseReadonlyAcquireOptions : Record<string, never>;

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`缺少 ${name}`);
  return value.trim();
}

function capabilityBase(runtimeApiBase: string): string {
  return runtimeApiBase.replace(/\/api\/runtime\/?$/, '');
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 非 JSON 错误沿用响应正文。
  }
  return text || `HTTP ${response.status}`;
}

/**
 * Workload SDK 只接收 run 注入的 token，不接收 tenant、space 或业务插件 ID；服务端必须从
 * token 推导这些身份并执行空间级能力检查。插件声明只用于配置提示，不是 key 级授权。
 * 调用方也不应该把 token 写入日志或持久化文件。
 */
export class RunForgeWorkloadClient {
  private readonly token: string;
  private readonly runtimeApiBase: string;
  private readonly stepId?: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: WorkloadClientOptions = {}) {
    this.token = required(options.token ?? process.env.WORKLOAD_TOKEN, 'WORKLOAD_TOKEN');
    this.runtimeApiBase = required(
      options.runtimeApiBase ?? process.env.RUNFORGE_RUNTIME_API_BASE,
      'RUNFORGE_RUNTIME_API_BASE',
    ).replace(/\/$/, '');
    this.stepId = options.stepId ?? process.env.RUNFORGE_STEP_ID;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async post<T>(url: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(this.stepId ? { 'X-RunForge-Step-Id': this.stepId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.json() as Promise<T>;
  }

  readonly secrets = {
    get: async (key: string): Promise<string> => {
      const result = await this.post<WorkloadSecretResponse>(
        `${this.runtimeApiBase}/secrets/get`,
        { key: required(key, 'Secret key') },
      );
      return result.value;
    },
  };

  readonly resources = {
    acquire: async <T extends WorkloadResourceType>(
      type: T,
      options?: WorkloadResourceOptions<T>,
    ): Promise<WorkloadResourceResult<T>> => {
      if (type === 'database.readonly') {
        const configured = options as DatabaseReadonlyAcquireOptions | undefined;
        const datasourceId = required(configured?.datasourceId ?? process.env.DATASOURCE_ID, 'datasourceId/DATASOURCE_ID');
        const profile = required(configured?.profile ?? process.env.DATASOURCE_PROFILE ?? 'readonly', 'profile/DATASOURCE_PROFILE');
        return this.post<PublicCredentialResponse>(
          `${this.runtimeApiBase}/datasources/${encodeURIComponent(datasourceId)}/credentials`,
          { profile },
        ) as Promise<WorkloadResourceResult<T>>;
      }
      if (type === 'llm.proxy') {
        return this.post<RuntimeCapabilityCredential>(
          `${capabilityBase(this.runtimeApiBase)}/api/runtime-capabilities/credentials`,
          { capability: 'llm' },
        ) as Promise<WorkloadResourceResult<T>>;
      }
      throw new Error(`不支持的 Workload 资源：${String(type)}`);
    },
  };
}
