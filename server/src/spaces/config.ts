import {
  spaceConfigSchema,
  type RuntimeCapabilitiesSettings,
  type RuntimeCapabilityName,
  type LlmModelOption,
  type SpaceConfig,
  type SpaceMode,
  type SpaceOptions,
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
import { createBusinessPluginSelection } from '../businessPlugins/cordis.js';
import { businessPluginRegistry } from '../businessPlugins/registry.js';
import {
  businessPluginReadiness,
  getBusinessPluginTenantSettings,
} from '../businessPlugins/settings.js';
import type { BusinessPluginDefinition } from '../businessPlugins/types.js';
import { createSpaceRuntimeLock } from '../plugins/lock.js';
import type { JsonValue, SpaceRuntimeLock } from '../plugins/types.js';

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
  modelOptions: LlmModelOption[];
  toolNames: string[];
  mcpServerIds: string[];
  mcpServers: Array<{ id: string; label: string }>;
  businessPluginIds: string[];
  businessPlugins: Array<{ id: string; label: string; description: string; contentHash: string }>;
  businessPluginDefinitions: BusinessPluginDefinition[];
  businessPluginConfigs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
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
    businessPlugins: string[];
    runtime: RuntimeCapabilityName[];
  };
  external: {
    allowTrustedPrompt: boolean;
    allowNextStep: boolean;
    trustedPrompt?: string;
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
  pluginLock: SpaceRuntimeLock;
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
      businessPlugins: unique(config.capabilities.businessPlugins),
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
      modelOptions: [{
        ref: modelRef,
        providerId: 'default',
        providerLabel: 'Default',
        provider: 'mock',
        model: instanceConfig.llm.model,
        label: instanceConfig.llm.model,
      }],
      toolNames: builtinToolNames(),
      mcpServerIds: [],
      mcpServers: [],
      businessPluginIds: [],
      businessPlugins: [],
      businessPluginDefinitions: [],
      businessPluginConfigs: {},
      runtimeCapabilities: [],
      runtimeSettings: {
        llm: { enabled: false, defaultModelId: '', models: [] },
        image: { enabled: false, defaultModelId: '', models: [] },
        video: { enabled: false, defaultModelId: '', models: [] },
      },
    };
  }

  const [llm, mcp, runtime, datasources, pluginDefinitions, pluginSettings] = await Promise.all([
    getLlmSettings({ tenantId }),
    getMcpSettings({ tenantId }),
    getRuntimeCapabilitiesSettings({ tenantId }),
    listDatasources({ tenantId }),
    businessPluginRegistry.list(tenantId),
    getBusinessPluginTenantSettings(tenantId),
  ]);
  const models = llmModelOptions(llm);
  const enabledMcpServers = mcp.servers.filter((server) => server.enabled);
  const readyPlugins = businessPluginReadiness(pluginDefinitions, pluginSettings)
    .filter((item) => item.ready)
    .map((item) => item.definition);
  return {
    defaultModelRef: llm.defaultModelRef,
    modelContextWindows: contextWindows(llm),
    modelRefs: models.map((model) => model.ref),
    modelOptions: models,
    toolNames: builtinToolNames(),
    mcpServerIds: enabledMcpServers.map((server) => server.id),
    mcpServers: enabledMcpServers.map((server) => ({ id: server.id, label: server.label || server.id })),
    businessPluginIds: readyPlugins.map((definition) => definition.manifest.id),
    businessPlugins: readyPlugins.map((definition) => ({
      id: definition.manifest.id,
      label: definition.manifest.displayName,
      description: definition.manifest.description,
      contentHash: definition.contentHash,
    })),
    businessPluginDefinitions: readyPlugins,
    businessPluginConfigs: Object.fromEntries(readyPlugins.map((definition) => [
      definition.manifest.id,
      Object.prototype.hasOwnProperty.call(pluginSettings.plugins, definition.manifest.id)
        ? pluginSettings.plugins[definition.manifest.id]!.config
        : {},
    ])),
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

  async options(tenantId: string): Promise<SpaceOptions> {
    const catalog = await this.loadCatalog(tenantId);
    return {
      defaultModelRef: catalog.defaultModelRef,
      models: catalog.modelOptions,
      tools: catalog.toolNames,
      mcpServers: catalog.mcpServers,
      businessPlugins: catalog.businessPlugins,
      runtimeCapabilities: catalog.runtimeCapabilities,
    };
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
    const selectedDefinitions = new Map(
      catalog.businessPluginDefinitions.map((definition) => [definition.manifest.id, definition]),
    );
    const pluginLock = createSpaceRuntimeLock({
      tenantId,
      spaceId: space.id,
      configVersion: space.config_version,
      plugins: resolved.capabilities.businessPlugins.map((id) => {
        const definition = selectedDefinitions.get(id);
        if (!definition) throw new SpaceConfigError(`业务插件不属于当前 tenant 可用目录：${id}`);
        return createBusinessPluginSelection(
          definition,
          { ...(catalog.businessPluginConfigs[id] ?? {}) } as JsonValue,
        );
      }),
    });
    return {
      configVersion: space.config_version,
      modelRef: resolved.model.modelRef,
      snapshot: {
        ...resolved,
        spaceId: space.id,
      },
      runtimeCapabilitiesSnapshot: runtimeSnapshot(catalog, resolved.capabilities.runtime),
      pluginLock,
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
    const businessPlugins = selectValues(
      config.capabilities.businessPlugins,
      catalog.businessPluginIds,
      '业务插件',
    );
    const runtime = selectValues(
      config.capabilities.runtime,
      catalog.runtimeCapabilities,
      '运行时能力',
    ) as RuntimeCapabilityName[];
    const definitions = new Map(catalog.businessPluginDefinitions.map((definition) => [definition.manifest.id, definition]));
    const requiredRuntime = new Set<RuntimeCapabilityName>();
    for (const pluginId of businessPlugins) {
      const definition = definitions.get(pluginId);
      if (!definition) throw new SpaceConfigError(`业务插件不属于当前 tenant 可用目录：${pluginId}`);
      for (const resource of definition.manifest.resources) {
        if (resource.type === 'database.readonly') requiredRuntime.add('datasource.credentials');
        if (resource.type === 'llm.proxy') requiredRuntime.add('llm');
      }
    }
    const missingRuntime = [...requiredRuntime].filter((capability) => !runtime.includes(capability));
    if (missingRuntime.length) {
      throw new SpaceConfigError(`业务插件所需运行资源未被空间授权：${missingRuntime.join(', ')}`);
    }

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
      capabilities: { tools, mcpServers, businessPlugins, runtime },
      external: { ...config.external },
    };
  }
}

export const spaceConfigService = new SpaceConfigService();
