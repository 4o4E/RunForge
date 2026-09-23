import {
  spaceConfigSchema,
  type RuntimeCapabilitiesSettings,
  type RuntimeCapabilityName,
  type LlmModelOption,
  type PromptPlaceholdersView,
  type SpaceConfig,
  type SpaceDebugMcpSchema,
  type SpaceDebugView,
  type SpaceMode,
  type SpaceOptions,
} from '@runforge/contracts';
import { resolve } from 'node:path';
import { agentContextSettings, config as instanceConfig } from '../config.js';
import { listAuthorizedDatasources } from '../datasources/accountPool.js';
import {
  getLlmSettings,
  getSystemMcpSettings,
  getRuntimeCapabilitiesSettings,
  getSystemToolSettings,
  llmModelOptions,
} from '../settings.js';
import type { SpaceWithVisibilityRow } from '../store/types.js';
import { builtinToolNames, getTool } from '../tools/registry.js';
import { createBusinessPluginSelection } from '../businessPlugins/cordis.js';
import { resolveBusinessPluginMcpServer } from '../businessPlugins/runtime.js';
import { businessPluginRegistry } from '../businessPlugins/registry.js';
import {
  businessPluginReadiness,
  getBusinessPluginTenantSettings,
} from '../businessPlugins/settings.js';
import type { BusinessPluginDefinition } from '../businessPlugins/types.js';
import { createSpaceRuntimeLock } from '../plugins/lock.js';
import type { JsonValue, SpaceRuntimeLock } from '../plugins/types.js';
import {
  loadBuiltinSkillDocuments,
  readSkillEntryDocument,
  renderSkillCatalog,
  renderSkillSystemRules,
} from '../skills/registry.js';
import { probeMcpServer } from '../mcp/client.js';
import { renderMcpCatalog, renderMcpSystemRules } from '../mcp/client.js';
import {
  loadBuiltinWorkflowIndex,
  renderWorkflowCatalog,
  renderWorkflowSystemRules,
} from '../workflows/registry.js';
import {
  defaultPromptTemplate,
  promptPlaceholders as buildPromptPlaceholders,
  runtimeCapabilityPromptValues,
  validatePromptTemplate,
} from './prompt.js';

export class SpaceConfigError extends Error {
  readonly code = 'SPACE_CONFIG_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'SpaceConfigError';
  }
}

export interface TenantSpaceCapabilityCatalog {
  defaultModelRef: string;
  modelContexts: Record<string, { contextWindow: number; compactionThreshold: number }>;
  modelRefs: string[];
  modelOptions: LlmModelOption[];
  toolNames: string[];
  mcpServerIds: string[];
  mcpServers: Array<{ id: string; label: string; description?: string }>;
  businessPluginIds: string[];
  businessPlugins: Array<{ id: string; label: string; description: string; contentHash: string; dependencies?: string[] }>;
  businessPluginDefinitions: BusinessPluginDefinition[];
  businessPluginConfigs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  runtimeCapabilities: RuntimeCapabilityName[];
  runtimeSettings: RuntimeCapabilitiesSettings;
}

export interface RunSpaceConfigSnapshot {
  schemaVersion: 3;
  spaceId: string;
  mode: SpaceMode;
  promptTemplate: string;
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
    allowUserFiles?: boolean;
    userFilesUserId?: string | null;
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

function expandBusinessPluginSelection(
  selected: readonly string[],
  definitions: readonly BusinessPluginDefinition[],
): string[] {
  const byId = new Map(definitions.map((definition) => [definition.manifest.id, definition]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const definition = byId.get(id);
    if (!definition) throw new SpaceConfigError(`业务插件不属于当前 tenant 可用目录：${id}`);
    if (visiting.has(id)) throw new SpaceConfigError(`业务插件依赖存在循环：${id}`);
    visiting.add(id);
    for (const dependency of definition.manifest.dependencies ?? []) {
      if (!dependency.optional) visit(dependency.id);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const id of selected) visit(id);
  return ordered;
}

function normalizeParsedConfig(config: SpaceConfig): SpaceConfig {
  return {
    ...config,
    promptTemplate: validatePromptTemplate(config.promptTemplate),
    model: {
      ...config.model,
      allowedModelRefs: unique(config.model.allowedModelRefs),
    },
    capabilities: {
      tools: unique(config.capabilities.tools),
      mcpServers: unique(config.capabilities.mcpServers),
      businessPlugins: unique(config.capabilities.businessPlugins),
      runtime: [...new Set(config.capabilities.runtime)],
    },
  };
}

export function normalizeSpaceConfig(value: unknown, mode: SpaceMode = 'web'): SpaceConfig {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : value;
  let candidate = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const object = raw as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(object, 'schemaVersion')
      && object.schemaVersion !== 1
      && object.schemaVersion !== 3
    ) {
      throw new SpaceConfigError('schemaVersion: 只支持 1 或 3');
    }
    if (Object.prototype.hasOwnProperty.call(object, 'systemPrompt') && typeof object.systemPrompt !== 'string') {
      throw new SpaceConfigError('systemPrompt: 必须是字符串');
    }
    const promptTemplate = Object.prototype.hasOwnProperty.call(object, 'promptTemplate')
      ? object.promptTemplate
      : defaultPromptTemplate(mode, typeof object.systemPrompt === 'string' ? object.systemPrompt : '');
    const {
      systemPrompt: _legacySystemPrompt,
      ...rest
    } = object;
    candidate = { ...rest, schemaVersion: 3, promptTemplate };
  } else if (raw == null) {
    candidate = { schemaVersion: 3, promptTemplate: defaultPromptTemplate(mode) };
  }
  const parsed = spaceConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new SpaceConfigError(`${path}${issue?.message ?? '空间配置格式无效'}`);
  }
  try {
    return normalizeParsedConfig(parsed.data);
  } catch (error) {
    throw new SpaceConfigError((error as Error).message);
  }
}

function missingValues(selected: readonly string[], available: ReadonlySet<string>): string[] {
  return selected.filter((value) => !available.has(value));
}

function configObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpaceConfigError(`${field}必须是对象`);
  }
  return value as Record<string, unknown>;
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

function modelContexts(settings: Awaited<ReturnType<typeof getLlmSettings>>): TenantSpaceCapabilityCatalog['modelContexts'] {
  return Object.fromEntries(settings.providers.flatMap((provider) => provider.models.flatMap((model) => {
    const capability = provider.modelCapabilities.find((item) => item.model === model);
    return capability?.contextWindow && capability.compactionThreshold
      ? [[`${provider.id}:${model}`, {
          contextWindow: capability.contextWindow,
          compactionThreshold: capability.compactionThreshold,
        }] as const]
      : [];
  })));
}

async function loadCatalogFromTenant(tenantId: string): Promise<TenantSpaceCapabilityCatalog> {
  // MemoryStore 是离线/测试实现，没有 app_settings repository；沿用实例默认模型，
  // 其余能力为空。生产 PgStore 始终从当前 tenant 的独立配置读取目录。
  if (process.env.STORE === 'memory') {
    const modelRef = `default:${instanceConfig.llm.model}`;
    return {
      defaultModelRef: modelRef,
      modelContexts: {
        [modelRef]: {
          contextWindow: instanceConfig.agent.modelContextWindow,
          compactionThreshold: instanceConfig.agent.contextBudget,
        },
      },
      modelRefs: [modelRef],
      modelOptions: [{
        ref: modelRef,
        providerId: 'default',
        providerLabel: 'Default',
        protocol: 'openai-chat',
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
    getSystemMcpSettings(),
    getRuntimeCapabilitiesSettings({ tenantId }),
    listAuthorizedDatasources({ tenantId }),
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
    modelContexts: modelContexts(llm),
    modelRefs: models.map((model) => model.ref),
    modelOptions: models,
    toolNames: builtinToolNames(),
    mcpServerIds: enabledMcpServers.map((server) => server.id),
    mcpServers: enabledMcpServers.map((server) => ({
      id: server.id,
      label: server.label || server.id,
      description: server.description,
    })),
    businessPluginIds: readyPlugins.map((definition) => definition.manifest.id),
    businessPlugins: readyPlugins.map((definition) => ({
      id: definition.manifest.id,
      label: definition.manifest.displayName,
      description: definition.manifest.description,
      contentHash: definition.contentHash,
      // 空间选择只自动加入必需依赖；可选依赖必须由管理员单独选择。
      dependencies: (definition.manifest.dependencies ?? [])
        .filter((dependency) => !dependency.optional)
        .map((dependency) => dependency.id),
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
  configured: readonly string[],
  available: readonly string[],
  label: string,
): string[] {
  const selected = unique(configured);
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
    const config = normalizeSpaceConfig(value, mode);
    this.resolve(mode, config, await this.loadCatalog(tenantId));
    return config;
  }

  async snapshotForCreate(
    tenantId: string,
    mode: SpaceMode,
    value: unknown = {},
    requireRunnable = true,
  ): Promise<SpaceConfig> {
    const catalog = await this.loadCatalog(tenantId);
    const body = configObject(value, '空间配置');
    const model = configObject(body.model, 'model');
    const capabilities = configObject(body.capabilities, 'capabilities');
    const allowedModelRefs = Array.isArray(model.allowedModelRefs)
      ? model.allowedModelRefs
      : catalog.modelRefs;
    const selectedTools = Array.isArray(capabilities.tools) ? capabilities.tools : catalog.toolNames;
    const defaultModelRef = typeof model.defaultModelRef === 'string' && model.defaultModelRef.trim()
      ? model.defaultModelRef
      : allowedModelRefs.includes(catalog.defaultModelRef)
        ? catalog.defaultModelRef
        : allowedModelRefs[0] ?? null;
    const requestedBusinessPlugins = Array.isArray(capabilities.businessPlugins) ? capabilities.businessPlugins : [];
    const businessPlugins = expandBusinessPluginSelection(requestedBusinessPlugins, catalog.businessPluginDefinitions);
    const config = normalizeSpaceConfig({
      ...body,
      model: {
        ...model,
        defaultModelRef,
        allowedModelRefs,
      },
      capabilities: {
        ...capabilities,
        tools: mode === 'external' ? selectedTools.filter((tool) => tool !== 'ask_user') : selectedTools,
        mcpServers: Array.isArray(capabilities.mcpServers) ? capabilities.mcpServers : catalog.mcpServerIds,
        businessPlugins,
        runtime: Array.isArray(capabilities.runtime) ? capabilities.runtime : catalog.runtimeCapabilities,
      },
    }, mode);
    if (requireRunnable) this.resolve(mode, config, catalog);
    return config;
  }

  async options(tenantId: string): Promise<SpaceOptions> {
    const catalog = await this.loadCatalog(tenantId);
    return {
      defaultModelRef: catalog.defaultModelRef,
      models: catalog.modelOptions,
      tools: catalog.toolNames,
      mcpServers: catalog.mcpServers.map(({ id, label }) => ({ id, label })),
      businessPlugins: catalog.businessPlugins,
      runtimeCapabilities: catalog.runtimeCapabilities,
    };
  }

  async promptPlaceholders(
    tenantId: string,
    mode: SpaceMode,
    value: unknown,
    userId?: string | null,
  ): Promise<PromptPlaceholdersView> {
    const config = normalizeSpaceConfig(value, mode);
    const [catalog, toolSettings, workflows, builtinSkills] = await Promise.all([
      this.loadCatalog(tenantId),
      getSystemToolSettings(),
      loadBuiltinWorkflowIndex(),
      loadBuiltinSkillDocuments(),
    ]);
    const selectedMcpServerIds = selectValues(
      config.capabilities.mcpServers,
      catalog.mcpServerIds,
      'MCP Server',
    );
    const selectedBusinessPluginIds = selectValues(
      config.capabilities.businessPlugins,
      catalog.businessPluginIds,
      '业务插件',
    );
    const selectedRuntimeCapabilities = selectValues(
      config.capabilities.runtime,
      catalog.runtimeCapabilities,
      '运行时能力',
    ) as RuntimeCapabilityName[];
    const selectedDefinitions = new Map(
      catalog.businessPluginDefinitions.map((definition) => [definition.manifest.id, definition]),
    );
    const businessSkills = await Promise.all(selectedBusinessPluginIds.flatMap((pluginId) => {
      const definition = selectedDefinitions.get(pluginId);
      if (!definition) throw new SpaceConfigError(`业务插件不属于当前 tenant 可用目录：${pluginId}`);
      return definition.manifest.skills.map(async (skill) => {
        const entry = await readSkillEntryDocument(resolve(definition.root, skill.path));
        if (entry.name !== skill.id) {
          throw new Error(`${resolve(definition.root, skill.path, 'SKILL.md')} 的 name 必须是 ${skill.id}`);
        }
        return {
          id: `business:${pluginId}/${skill.id}`,
          name: entry.name,
          description: entry.description,
          source: 'business' as const,
        };
      });
    }));
    const skills = [
      ...builtinSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: 'builtin' as const,
      })),
      ...businessSkills,
    ].sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
    const systemMcp = new Map(catalog.mcpServers.map((server) => [server.id, server]));
    const mcpServers = selectedMcpServerIds.map((id) => {
      const server = systemMcp.get(id);
      if (!server) throw new SpaceConfigError(`空间配置引用了不可用的 MCP Server：${id}`);
      return { id, description: server.description ?? '', enabled: true };
    });
    for (const pluginId of selectedBusinessPluginIds) {
      const definition = selectedDefinitions.get(pluginId)!;
      mcpServers.push(...definition.manifest.mcpServers.map((server) => ({
        id: `business-${pluginId}-${server.id}`,
        description: server.description,
        enabled: true,
      })));
    }
    const capabilitySnapshot = runtimeSnapshot(catalog, selectedRuntimeCapabilities);
    const runtimeValues = runtimeCapabilityPromptValues(capabilitySnapshot);
    const allowedCapabilities = capabilitySnapshot.allowedCapabilities.join(', ') || '无';
    const userFilesMapped = toolSettings.sandbox === 'enforce'
      && toolSettings.sandboxBackend === 'bwrap'
      && !toolSettings.shellUseHostPath;

    return {
      placeholders: buildPromptPlaceholders({
        'workspace.root': '[运行时分配的持久工作区路径]',
        'user.filesRoot': (mode === 'web' || config.external.allowUserFiles) && userFilesMapped
          ? (userId ? `/u/${userId}` : '/u/<运行时用户ID>')
          : '已禁用',
        'sandbox.mode': toolSettings.sandbox,
        'sandbox.backend': toolSettings.sandboxBackend,
        'shell.hostPath': toolSettings.shellUseHostPath ? '是' : '否',
        'network.mode': toolSettings.network,
        'workflow.catalog': [
          renderWorkflowSystemRules(),
          renderWorkflowCatalog(workflows),
        ].join('\n\n'),
        'skills.catalog': [
          renderSkillSystemRules(),
          renderSkillCatalog(skills),
        ].join('\n\n'),
        'mcp.catalog': [renderMcpSystemRules(), renderMcpCatalog({ servers: mcpServers })].join('\n\n'),
        'runtime.environment': [
          '统一运行资源环境（run 级）:',
          '- WORKLOAD_TOKEN=[运行时生成的短期能力令牌]',
          '- RUNFORGE_RUNTIME_API_BASE=[运行时资源接口地址]',
          '- DATASOURCE_ID=[运行时根据已授权数据源决定]',
          '- DATASOURCE_PROFILE=[运行时只读权限配置]',
          '- allowedDatasourceIds=[运行时根据租户授权和空间能力决定]',
          `- allowedCapabilities=${allowedCapabilities}`,
          '- WORKLOAD_TOKEN 只用于换取本次运行的短期凭证和内部能力代理配置。',
          '- 数据库命令通过 database-access helper 换取本次运行的短期凭证。',
        ].join('\n'),
        'runtime.enabledCapabilities': runtimeValues.enabledCapabilities,
        'runtime.capabilityDetails': runtimeValues.capabilityDetails,
        'external.trustedPrompt': '[外部调用方在本次请求中传入的可信提示词]',
      }),
    };
  }

  async debugView(
    tenantId: string,
    configVersion: number,
    mode: SpaceMode,
    value: unknown,
  ): Promise<SpaceDebugView> {
    const config = normalizeSpaceConfig(value, mode);
    const catalog = await this.loadCatalog(tenantId);
    const tools = config.capabilities.tools.map((name) => {
      const tool = getTool(name);
      if (!tool) throw new SpaceConfigError(`空间配置引用了不存在的工具：${name}`);
      return { name: tool.name, description: tool.description, parameters: tool.parameters };
    });

    const systemMcp = new Map(catalog.mcpServers.map((server) => [server.id, server]));
    const mcpServers: SpaceDebugView['mcpServers'] = config.capabilities.mcpServers.map((id) => {
      const server = systemMcp.get(id);
      if (!server) throw new SpaceConfigError(`空间配置引用了不可用的 MCP Server：${id}`);
      return { id: server.id, label: server.label, description: server.description ?? '' };
    });

    const definitions = new Map(
      catalog.businessPluginDefinitions.map((definition) => [definition.manifest.id, definition]),
    );
    const skills: SpaceDebugView['skills'] = (await loadBuiltinSkillDocuments()).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
    }));
    for (const pluginId of config.capabilities.businessPlugins) {
      const definition = definitions.get(pluginId);
      if (!definition) throw new SpaceConfigError(`空间配置引用了不可用的业务插件：${pluginId}`);
      const pluginSkills = await Promise.all(definition.manifest.skills.map(async (skill) => {
        const root = resolve(definition.root, skill.path);
        const entry = await readSkillEntryDocument(root);
        if (entry.name !== skill.id) {
          throw new Error(`${resolve(root, 'SKILL.md')} 的 name 必须是 ${skill.id}`);
        }
        return {
          id: `business:${pluginId}/${skill.id}`,
          name: entry.name,
          description: entry.description,
          content: entry.content,
        };
      }));
      skills.push(...pluginSkills);
      mcpServers.push(...definition.manifest.mcpServers.map((server) => ({
        id: `business-${pluginId}-${server.id}`,
        label: server.label,
        description: server.description,
      })));
    }

    return {
      configVersion,
      promptTemplate: config.promptTemplate,
      tools,
      skills,
      mcpServers,
    };
  }

  async debugMcpSchema(
    tenantId: string,
    value: unknown,
    mcpId: string,
  ): Promise<SpaceDebugMcpSchema> {
    const config = normalizeSpaceConfig(value);
    const catalog = await this.loadCatalog(tenantId);
    let server;
    if (config.capabilities.mcpServers.includes(mcpId)) {
      const settings = await getSystemMcpSettings();
      server = settings.servers.find((candidate) => candidate.id === mcpId && candidate.enabled);
      if (!server) throw new SpaceConfigError(`空间配置引用了不可用的 MCP Server：${mcpId}`);
    } else {
      const definitions = new Map(
        catalog.businessPluginDefinitions.map((definition) => [definition.manifest.id, definition]),
      );
      const selected = config.capabilities.businessPlugins
        .map((pluginId) => definitions.get(pluginId))
        .find((definition) => definition?.manifest.mcpServers.some((candidate) => (
          `business-${definition.manifest.id}-${candidate.id}` === mcpId
        )));
      if (!selected) throw new SpaceConfigError(`空间配置没有声明 MCP Server：${mcpId}`);
      const declaration = selected.manifest.mcpServers.find((candidate) => (
        `business-${selected.manifest.id}-${candidate.id}` === mcpId
      ))!;
      const settings = await getBusinessPluginTenantSettings(tenantId);
      server = resolveBusinessPluginMcpServer(
        selected,
        declaration.id,
        settings.plugins[selected.manifest.id]?.config ?? {},
        settings.secrets,
      );
    }
    const tools = await probeMcpServer(server);
    return {
      tools: tools.map((tool) => ({
        name: tool.mappedName,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };
  }

  async resolveForRun(
    tenantId: string,
    space: SpaceWithVisibilityRow,
    requestedModelRef?: string | null,
  ): Promise<ResolvedRunSpaceConfig> {
    if (space.tenant_id !== tenantId) throw new SpaceConfigError('空间不属于当前 tenant');
    const config = normalizeSpaceConfig(space.config, space.mode);
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
        external: {
          ...resolved.external,
          userFilesUserId: space.mode === 'external' ? space.execution_user_id : null,
        },
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
    const allowedModelRefs = unique(config.model.allowedModelRefs);
    const unavailableModelRefs = missingValues(allowedModelRefs, new Set(catalog.modelRefs));
    if (unavailableModelRefs.length) {
      throw new SpaceConfigError(
        `空间配置的模型当前不可用：${unavailableModelRefs.join(', ')}。请确认模型已启用、能力参数已配置且当前租户拥有供应商权限，或在空间设置中移除该模型。`,
      );
    }
    if (!allowedModelRefs.length) throw new SpaceConfigError('空间至少需要允许一个主 Agent 模型');
    const configuredDefault = config.model.defaultModelRef;
    if (configuredDefault && !allowedModelRefs.includes(configuredDefault)) {
      throw new SpaceConfigError(`默认模型不在空间允许列表中：${configuredDefault}`);
    }
    const modelRef = requestedModelRef?.trim() || configuredDefault || allowedModelRefs[0];
    if (!allowedModelRefs.includes(modelRef)) {
      throw new SpaceConfigError(`模型未被当前空间允许：${modelRef}`);
    }
    const modelContext = catalog.modelContexts[modelRef];
    if (!modelContext) throw new SpaceConfigError(`模型缺少上下文窗口或压缩阈值配置：${modelRef}`);
    const { contextWindow } = modelContext;
    const defaultContext = agentContextSettings(contextWindow, modelContext.compactionThreshold);
    // 模型阈值和 instance 预算都是空间预算的上限；run 副本始终记录真正生效的最小值。
    const configuredContextBudget = config.model.contextBudget;
    const contextBudget = Math.min(
      configuredContextBudget ?? defaultContext.contextBudget,
      defaultContext.contextBudget,
      contextWindow,
    );
    const tools = selectValues(config.capabilities.tools, catalog.toolNames, '工具')
      .filter((tool) => mode !== 'external' || tool !== 'ask_user');
    const mcpServers = selectValues(config.capabilities.mcpServers, catalog.mcpServerIds, 'MCP Server');
    const selectedBusinessPlugins = selectValues(
      config.capabilities.businessPlugins,
      catalog.businessPluginIds,
      '业务插件',
    );
    const businessPlugins = expandBusinessPluginSelection(selectedBusinessPlugins, catalog.businessPluginDefinitions);
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
        if (resource.type === 'image.proxy') requiredRuntime.add('image');
      }
    }
    const missingRuntime = [...requiredRuntime].filter((capability) => !runtime.includes(capability));
    if (missingRuntime.length) {
      throw new SpaceConfigError(`业务插件所需运行资源未被空间授权：${missingRuntime.join(', ')}`);
    }

    return {
      schemaVersion: 3,
      mode,
      promptTemplate: config.promptTemplate,
      model: {
        modelRef,
        allowedModelRefs,
        contextWindow,
        contextBudget,
        contextBudgetSource: configuredContextBudget !== null && configuredContextBudget < defaultContext.contextBudget
          ? 'space-config'
          : defaultContext.contextBudgetSource,
      },
      capabilities: { tools, mcpServers, businessPlugins, runtime },
      external: { ...config.external },
    };
  }
}

export const spaceConfigService = new SpaceConfigService();
