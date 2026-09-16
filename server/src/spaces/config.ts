import {
  spaceConfigSchema,
  type RuntimeCapabilitiesSettings,
  type RuntimeCapabilityName,
  type SpaceConfig,
  type SpaceMode,
} from '@runforge/contracts';
import { agentContextSettings, config as instanceConfig } from '../config.js';
import { listDatasources } from '../datasources/accountPool.js';
import {
  getLlmSettings,
  getMcpSettings,
  getRuntimeCapabilitiesSettings,
  llmModelOptions,
} from '../settings.js';
import type { SpaceWithVisibilityRow } from '../store/types.js';
import { builtinToolNames } from '../tools/registry.js';

export class SpaceConfigError extends Error {
  readonly code = 'SPACE_CONFIG_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'SpaceConfigError';
  }
}

export interface TenantSpaceCapabilityCatalog {
  defaultModelRef: string;
  modelContextWindows: Record<string, number>;
  modelRefs: string[];
  toolNames: string[];
  mcpServerIds: string[];
  runtimeCapabilities: RuntimeCapabilityName[];
  runtimeSettings: RuntimeCapabilitiesSettings;
}

export interface RunSpaceConfigSnapshot {
  schemaVersion: 1;
  spaceId: string;
  mode: SpaceMode;
  systemPrompt: string;
  model: {
    modelRef: string;
    allowedModelRefs: string[];
    contextWindow: number;
    contextBudget: number;
    contextBudgetSource: string;
  };
  capabilities: {
    tools: string[];
    mcpServers: string[];
    runtime: RuntimeCapabilityName[];
  };
  external: {
    allowTrustedPrompt: boolean;
    allowNextStep: boolean;
  };
}

interface PublicRuntimeCapability {
  enabled: boolean;
  defaultModelId: string;
  models: Array<{ id: string; label: string }>;
}

/** run 只保存公开能力目录和授权结果，不能复制 tenant 配置里的 API key/baseUrl。 */
export interface RuntimeCapabilitiesSnapshot {
  allowedCapabilities: RuntimeCapabilityName[];
  llm: PublicRuntimeCapability;
  image: PublicRuntimeCapability;
  video: PublicRuntimeCapability;
}

export interface ResolvedRunSpaceConfig {
  configVersion: number;
  modelRef: string;
  snapshot: RunSpaceConfigSnapshot;
  runtimeCapabilitiesSnapshot: RuntimeCapabilitiesSnapshot;
}

type CatalogLoader = (tenantId: string) => Promise<TenantSpaceCapabilityCatalog>;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeParsedConfig(config: SpaceConfig): SpaceConfig {
  return {
    ...config,
    systemPrompt: config.systemPrompt.trim(),
    model: {
      ...config.model,
      allowedModelRefs: config.model.allowedModelRefs === null ? null : unique(config.model.allowedModelRefs),
    },
    capabilities: {
      tools: config.capabilities.tools === null ? null : unique(config.capabilities.tools),
      mcpServers: config.capabilities.mcpServers === null ? null : unique(config.capabilities.mcpServers),
      runtime: config.capabilities.runtime === null
        ? null
        : [...new Set(config.capabilities.runtime)],
    },
  };
}

export function normalizeSpaceConfig(value: unknown): SpaceConfig {
  const parsed = spaceConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new SpaceConfigError(`${path}${issue?.message ?? '空间配置格式无效'}`);
  }
  return normalizeParsedConfig(parsed.data);
}

function missingValues(selected: readonly string[], available: ReadonlySet<string>): string[] {
  return selected.filter((value) => !available.has(value));
}

function enabledRuntimeCapabilities(
  settings: RuntimeCapabilitiesSettings,
  hasDatasources: boolean,
): RuntimeCapabilityName[] {
  const capabilities: RuntimeCapabilityName[] = [];
  if (hasDatasources) capabilities.push('datasource.credentials');
  if (settings.llm.enabled) capabilities.push('llm');
  if (settings.image.enabled) capabilities.push('image');
  if (settings.video.enabled) capabilities.push('video');
  return capabilities;
}

function contextWindows(settings: Awaited<ReturnType<typeof getLlmSettings>>): Record<string, number> {
  return Object.fromEntries(settings.providers.flatMap((provider) => provider.models.map((model) => [
    `${provider.id}:${model}`,
    provider.modelCapabilities.find((capability) => capability.model === model)?.contextWindow ?? 128_000,
  ])));
}

async function loadCatalogFromTenant(tenantId: string): Promise<TenantSpaceCapabilityCatalog> {
  // MemoryStore 是离线/测试实现，没有 app_settings repository；沿用实例默认模型，
  // 其余能力为空。生产 PgStore 始终从当前 tenant 的独立配置读取目录。
  if (process.env.STORE === 'memory') {
    const modelRef = `default:${instanceConfig.llm.model}`;
    return {
      defaultModelRef: modelRef,
      modelContextWindows: { [modelRef]: instanceConfig.agent.modelContextWindow },
      modelRefs: [modelRef],
      toolNames: builtinToolNames(),
      mcpServerIds: [],
      runtimeCapabilities: [],
      runtimeSettings: {
        llm: { enabled: false, defaultModelId: '', models: [] },
        image: { enabled: false, defaultModelId: '', models: [] },
        video: { enabled: false, defaultModelId: '', models: [] },
      },
    };
  }

  const [llm, mcp, runtime, datasources] = await Promise.all([
    getLlmSettings({ tenantId }),
    getMcpSettings({ tenantId }),
    getRuntimeCapabilitiesSettings({ tenantId }),
    listDatasources({ tenantId }),
  ]);
  return {
    defaultModelRef: llm.defaultModelRef,
    modelContextWindows: contextWindows(llm),
    modelRefs: llmModelOptions(llm).map((model) => model.ref),
    toolNames: builtinToolNames(),
    mcpServerIds: mcp.servers.filter((server) => server.enabled).map((server) => server.id),
    runtimeCapabilities: enabledRuntimeCapabilities(
      runtime,
      datasources.some((datasource) => datasource.enabled && datasource.status === 'active'),
    ),
    runtimeSettings: runtime,
  };
}

function selectValues(
  configured: readonly string[] | null,
  available: readonly string[],
  label: string,
): string[] {
  const selected = configured === null ? unique(available) : unique(configured);
  const missing = missingValues(selected, new Set(available));
  if (missing.length) throw new SpaceConfigError(`${label} 不属于当前 tenant 可用目录：${missing.join(', ')}`);
  return selected;
}

function publicCapability(
  value: RuntimeCapabilitiesSettings['llm'] | RuntimeCapabilitiesSettings['image'] | RuntimeCapabilitiesSettings['video'],
  enabled: boolean,
): PublicRuntimeCapability {
  return {
    enabled,
    defaultModelId: enabled ? value.defaultModelId : '',
    models: enabled ? value.models.map((model) => ({ id: model.id, label: model.label })) : [],
  };
}

function runtimeSnapshot(
  catalog: TenantSpaceCapabilityCatalog,
  allowed: RuntimeCapabilityName[],
): RuntimeCapabilitiesSnapshot {
  const selected = new Set(allowed);
  return {
    allowedCapabilities: allowed,
    llm: publicCapability(catalog.runtimeSettings.llm, selected.has('llm')),
    image: publicCapability(catalog.runtimeSettings.image, selected.has('image')),
    video: publicCapability(catalog.runtimeSettings.video, selected.has('video')),
  };
}

export async function createTenantRuntimeCapabilitiesSnapshot(
  tenantId: string,
): Promise<RuntimeCapabilitiesSnapshot> {
  const catalog = await loadCatalogFromTenant(tenantId);
  return runtimeSnapshot(catalog, catalog.runtimeCapabilities);
}

export class SpaceConfigService {
  constructor(private readonly loadCatalog: CatalogLoader = loadCatalogFromTenant) {}

  async normalizeForSave(tenantId: string, mode: SpaceMode, value: unknown): Promise<SpaceConfig> {
    const config = normalizeSpaceConfig(value);
    this.resolve(mode, config, await this.loadCatalog(tenantId));
    return config;
  }

  async resolveForRun(
    tenantId: string,
    space: SpaceWithVisibilityRow,
    requestedModelRef?: string | null,
  ): Promise<ResolvedRunSpaceConfig> {
    if (space.tenant_id !== tenantId) throw new SpaceConfigError('空间不属于当前 tenant');
    const config = normalizeSpaceConfig(space.config);
    const catalog = await this.loadCatalog(tenantId);
    const resolved = this.resolve(space.mode, config, catalog, requestedModelRef);
    return {
      configVersion: space.config_version,
      modelRef: resolved.model.modelRef,
      snapshot: {
        ...resolved,
        spaceId: space.id,
      },
      runtimeCapabilitiesSnapshot: runtimeSnapshot(catalog, resolved.capabilities.runtime),
    };
  }

  private resolve(
    mode: SpaceMode,
    config: SpaceConfig,
    catalog: TenantSpaceCapabilityCatalog,
    requestedModelRef?: string | null,
  ): Omit<RunSpaceConfigSnapshot, 'spaceId'> {
    const allowedModelRefs = selectValues(config.model.allowedModelRefs, catalog.modelRefs, '模型');
    if (!allowedModelRefs.length) throw new SpaceConfigError('空间至少需要允许一个主 Agent 模型');
    const configuredDefault = config.model.defaultModelRef;
    if (configuredDefault && !allowedModelRefs.includes(configuredDefault)) {
      throw new SpaceConfigError(`默认模型不在空间允许列表中：${configuredDefault}`);
    }
    const inheritedDefault = allowedModelRefs.includes(catalog.defaultModelRef)
      ? catalog.defaultModelRef
      : allowedModelRefs[0];
    const modelRef = requestedModelRef?.trim() || configuredDefault || inheritedDefault;
    if (!allowedModelRefs.includes(modelRef)) {
      throw new SpaceConfigError(`模型未被当前空间允许：${modelRef}`);
    }
    const contextWindow = catalog.modelContextWindows[modelRef];
    if (!contextWindow) throw new SpaceConfigError(`模型缺少上下文窗口配置：${modelRef}`);
    const defaultContext = agentContextSettings(contextWindow);
    // instance 预算是所有空间的安全上限；即使环境变量误设得比模型窗口大，
    // run 快照也不能记录一个超过模型窗口的预算。
    const contextBudget = Math.min(
      config.model.contextBudget ?? defaultContext.contextBudget,
      defaultContext.contextBudget,
      contextWindow,
    );
    const tools = selectValues(config.capabilities.tools, catalog.toolNames, '工具')
      .filter((tool) => mode !== 'external' || tool !== 'ask_user');
    const mcpServers = selectValues(config.capabilities.mcpServers, catalog.mcpServerIds, 'MCP Server');
    const runtime = selectValues(
      config.capabilities.runtime,
      catalog.runtimeCapabilities,
      '运行时能力',
    ) as RuntimeCapabilityName[];

    return {
      schemaVersion: 1,
      mode,
      systemPrompt: config.systemPrompt,
      model: {
        modelRef,
        allowedModelRefs,
        contextWindow,
        contextBudget,
        contextBudgetSource: config.model.contextBudget === null
          ? defaultContext.contextBudgetSource
          : 'space-config',
      },
      capabilities: { tools, mcpServers, runtime },
      external: { ...config.external },
    };
  }
}

export const spaceConfigService = new SpaceConfigService();
