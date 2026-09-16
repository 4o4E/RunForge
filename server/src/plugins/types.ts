import type { ZodType } from 'zod';

export type Awaitable<T> = T | Promise<T>;
export type PluginDisposable = () => Awaitable<void>;

export type PluginContributionKind = 'tool' | 'skill' | 'mcp' | 'capability';

export interface PluginDependency {
  id: string;
  version?: string;
  optional?: boolean;
}
export interface PluginContributionDeclaration {
  kind: PluginContributionKind;
  id: string;
}

export interface RunForgePluginManifest {
  id: string;
  version: string;
  contentHash: string;
  dependencies?: readonly PluginDependency[];
  contributions?: readonly PluginContributionDeclaration[];
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface SpacePluginSelection {
  id: string;
  version: string;
  contentHash: string;
  config: JsonValue;
}

export interface SpaceRuntimeConfig {
  tenantId: string;
  spaceId: string;
  configVersion: number;
  plugins: readonly SpacePluginSelection[];
}

export interface SpaceRuntimeLock extends SpaceRuntimeConfig {
  hash: string;
}

export interface PluginContribution<T = unknown> {
  kind: PluginContributionKind;
  id: string;
  ownerPluginId: string;
  value: T;
}

export interface CapabilityCatalogSnapshot {
  tools: readonly PluginContribution[];
  skills: readonly PluginContribution[];
  mcpServers: readonly PluginContribution[];
  capabilities: readonly PluginContribution[];
}

export interface PluginSetupContext {
  readonly manifest: RunForgePluginManifest;
  getDependency<T = unknown>(pluginId: string): T;
  contribute<T>(kind: PluginContributionKind, id: string, value: T): void;
  effect(setup: () => Awaitable<PluginDisposable>, label?: string): void;
}

export interface PluginRunContext {
  readonly runId: string;
  readonly manifest: RunForgePluginManifest;
  readonly catalog: CapabilityCatalogSnapshot;
  getPluginService<T = unknown>(pluginId: string): T;
  effect(setup: () => Awaitable<PluginDisposable>, label?: string): void;
}

export interface PluginSetupResult<TService = unknown> {
  service?: TService;
  dispose?: PluginDisposable;
}

export interface RunForgePluginDefinition<TConfig = unknown, TService = unknown> {
  manifest: RunForgePluginManifest;
  configSchema: ZodType<TConfig>;
  setup?: (
    context: PluginSetupContext,
    config: TConfig,
  ) => Awaitable<PluginSetupResult<TService> | void>;
  activateRun?: (context: PluginRunContext, config: TConfig) => Awaitable<PluginDisposable | void>;
}

export type AnyPluginDefinition = RunForgePluginDefinition<any, any>;

export interface SpaceRuntimeView {
  readonly lock: SpaceRuntimeLock;
  readonly catalog: CapabilityCatalogSnapshot;
}

export interface RunRuntimeHandle extends SpaceRuntimeView {
  readonly runId: string;
  getPluginService<T = unknown>(pluginId: string): T;
  dispose(): Promise<void>;
}
