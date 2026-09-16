import { Context, type Fiber, type Plugin } from 'cordis';
import { DynamicCapabilityCatalog } from './catalog.js';
import { PluginRuntimeError } from './errors.js';
import { contributionKey, deploymentKey, resolvePluginGraph, validatePluginDefinition } from './graph.js';
import { createSpaceRuntimeLock, verifySpaceRuntimeLock } from './lock.js';
import type {
  AnyPluginDefinition,
  CapabilityCatalogSnapshot,
  JsonValue,
  PluginRunContext,
  PluginSetupContext,
  RunForgePluginDefinition,
  RunRuntimeHandle,
  SpaceRuntimeConfig,
  SpaceRuntimeLock,
  SpaceRuntimeView,
} from './types.js';

interface SpaceRuntimeRecord {
  readonly key: string;
  readonly scopeKey: string;
  readonly lock: SpaceRuntimeLock;
  readonly orderedDefinitions: readonly AnyPluginDefinition[];
  readonly catalog: DynamicCapabilityCatalog;
  readonly services: Map<string, unknown>;
  fiber: Fiber;
  context: Context;
  activeRuns: number;
  current: boolean;
  disposing?: Promise<void>;
}

function runtimeKey(lock: SpaceRuntimeLock): string {
  return `${lock.tenantId}\u0000${lock.spaceId}\u0000${lock.configVersion}\u0000${lock.hash}`;
}

function scopeKey(tenantId: string, spaceId: string): string {
  return `${tenantId}\u0000${spaceId}`;
}

function serviceName(pluginId: string): string {
  return `runforge.plugin.${pluginId}`;
}

function isRuntimeLock(input: SpaceRuntimeConfig | SpaceRuntimeLock): input is SpaceRuntimeLock {
  return typeof (input as SpaceRuntimeLock).hash === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CordisRuntimeManager {
  private readonly root = new Context();
  private readonly deployments = new Map<string, AnyPluginDefinition>();
  private readonly runtimes = new Map<string, SpaceRuntimeRecord>();
  private readonly loadingRuntimes = new Map<string, Promise<SpaceRuntimeRecord>>();
  private readonly currentBySpace = new Map<string, string>();
  private readonly runReservations = new Set<string>();
  private disposed = false;

  registerPlugin<TConfig, TService>(definition: RunForgePluginDefinition<TConfig, TService>): void {
    this.assertActive();
    validatePluginDefinition(definition);
    const { id, version, contentHash } = definition.manifest;
    const key = deploymentKey(id, version, contentHash);
    if (this.deployments.has(key)) {
      throw new PluginRuntimeError('DUPLICATE_DEPLOYMENT', `插件部署已注册：${id}@${version} (${contentHash})`);
    }
    this.deployments.set(key, definition);
  }

  createLock(input: SpaceRuntimeConfig): SpaceRuntimeLock {
    this.assertActive();
    const ordered = resolvePluginGraph(input.plugins, this.deployments);
    const definitions = new Map(ordered.map((definition) => [definition.manifest.id, definition]));
    const plugins = input.plugins.map((selection) => {
      const definition = definitions.get(selection.id)!;
      try {
        return {
          ...selection,
          config: definition.configSchema.parse(selection.config) as JsonValue,
        };
      } catch (error) {
        throw new PluginRuntimeError(
          'CONFIG_INVALID',
          `插件 ${selection.id}@${selection.version} 配置无效：${errorMessage(error)}`,
          { cause: error },
        );
      }
    });
    return createSpaceRuntimeLock({ ...input, plugins });
  }

  async activateSpace(input: SpaceRuntimeConfig | SpaceRuntimeLock): Promise<SpaceRuntimeView> {
    this.assertActive();
    const lock = this.prepareLock(input);
    const record = await this.ensureRuntime(lock);
    const previousKey = this.currentBySpace.get(record.scopeKey);
    record.current = true;
    this.currentBySpace.set(record.scopeKey, record.key);

    if (previousKey && previousKey !== record.key) {
      const previous = this.runtimes.get(previousKey);
      if (previous) {
        previous.current = false;
        await this.collectRuntime(previous);
      }
    }
    return this.view(record);
  }

  async deactivateSpace(tenantId: string, spaceId: string): Promise<void> {
    const key = scopeKey(tenantId, spaceId);
    const currentKey = this.currentBySpace.get(key);
    if (!currentKey) return;
    this.currentBySpace.delete(key);
    const record = this.runtimes.get(currentKey);
    if (!record) return;
    record.current = false;
    await this.collectRuntime(record);
  }

  async startRun(runId: string, input: SpaceRuntimeConfig | SpaceRuntimeLock): Promise<RunRuntimeHandle> {
    this.assertActive();
    if (!runId.trim()) throw new PluginRuntimeError('CONFIG_INVALID', 'runId 不能为空');
    if (this.runReservations.has(runId)) {
      throw new PluginRuntimeError('DUPLICATE_RUN', `run ${runId} 已经存在活动插件上下文`);
    }
    this.runReservations.add(runId);

    let record: SpaceRuntimeRecord | undefined;
    let runFiber: Fiber | undefined;
    try {
      const lock = this.prepareLock(input);
      record = await this.ensureRuntime(lock);
      record.activeRuns += 1;
      const catalog = record.catalog.snapshot();
      const runPlugin = this.createRunPlugin(runId, record, catalog);
      runFiber = record.context.plugin(runPlugin, {});
      await runFiber.await();

      let released = false;
      return {
        runId,
        lock: record.lock,
        catalog,
        getPluginService: <T>(pluginId: string) => this.getService<T>(record!, pluginId),
        dispose: async () => {
          if (released) return;
          released = true;
          try {
            await runFiber!.dispose();
          } finally {
            this.runReservations.delete(runId);
            record!.activeRuns -= 1;
            await this.collectRuntime(record!);
          }
        },
      };
    } catch (error) {
      this.runReservations.delete(runId);
      await runFiber?.dispose();
      if (record) {
        record.activeRuns -= 1;
        await this.collectRuntime(record);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(this.loadingRuntimes.values());
    await Promise.allSettled([...this.runtimes.values()].map((record) => this.disposeRuntime(record)));
    this.runtimes.clear();
    this.currentBySpace.clear();
    this.runReservations.clear();
  }

  private prepareLock(input: SpaceRuntimeConfig | SpaceRuntimeLock): SpaceRuntimeLock {
    if (!isRuntimeLock(input)) return this.createLock(input);
    const verified = verifySpaceRuntimeLock(input);
    const validated = this.createLock(verified);
    if (validated.hash !== verified.hash) {
      throw new PluginRuntimeError(
        'LOCK_HASH_MISMATCH',
        `空间 ${verified.spaceId} 配置版本 ${verified.configVersion} 不能由当前插件 schema 原样恢复`,
      );
    }
    return validated;
  }

  private async ensureRuntime(lock: SpaceRuntimeLock): Promise<SpaceRuntimeRecord> {
    const key = runtimeKey(lock);
    const loaded = this.runtimes.get(key);
    if (loaded?.disposing) {
      await loaded.disposing;
      return this.ensureRuntime(lock);
    }
    if (loaded) return loaded;
    const loading = this.loadingRuntimes.get(key);
    if (loading) return loading;

    const task = this.loadRuntime(lock);
    this.loadingRuntimes.set(key, task);
    try {
      const record = await task;
      this.runtimes.set(key, record);
      return record;
    } finally {
      this.loadingRuntimes.delete(key);
    }
  }

  private async loadRuntime(lock: SpaceRuntimeLock): Promise<SpaceRuntimeRecord> {
    const orderedDefinitions = resolvePluginGraph(lock.plugins, this.deployments);
    const key = runtimeKey(lock);
    const record: SpaceRuntimeRecord = {
      key,
      scopeKey: scopeKey(lock.tenantId, lock.spaceId),
      lock,
      orderedDefinitions,
      catalog: new DynamicCapabilityCatalog(),
      services: new Map(),
      fiber: undefined as unknown as Fiber,
      context: undefined as unknown as Context,
      activeRuns: 0,
      current: false,
    };

    const bootstrap: Plugin<{}> = {
      name: `runforge-space:${lock.spaceId}:${lock.configVersion}`,
      apply: async (ctx) => {
        // 每个空间版本使用独立 service label，同一插件的多个配置不会共享 Cordis service。
        let isolated = ctx;
        for (const definition of orderedDefinitions) {
          isolated = isolated.isolate(serviceName(definition.manifest.id));
        }
        record.context = isolated;

        const selections = new Map(lock.plugins.map((selection) => [selection.id, selection]));
        for (const definition of orderedDefinitions) {
          const selection = selections.get(definition.manifest.id)!;
          const fiber = isolated.plugin(this.createPluginAdapter(definition, record), selection.config);
          await fiber.await();
        }
        return () => record.services.clear();
      },
    };

    const fiber = this.root.plugin(bootstrap, {});
    record.fiber = fiber;
    try {
      await fiber.await();
      return record;
    } catch (error) {
      await fiber.dispose();
      throw error;
    }
  }

  private createPluginAdapter(definition: AnyPluginDefinition, record: SpaceRuntimeRecord): Plugin<unknown> {
    const selectedIds = new Set(record.lock.plugins.map((plugin) => plugin.id));
    const inject = Object.fromEntries(
      (definition.manifest.dependencies ?? [])
        .filter((dependency) => selectedIds.has(dependency.id))
        .map((dependency) => [serviceName(dependency.id), null]),
    );
    const declared = new Set(
      (definition.manifest.contributions ?? []).map((item) => contributionKey(item.kind, item.id)),
    );

    return {
      name: `${definition.manifest.id}@${definition.manifest.version}`,
      Config: definition.configSchema,
      inject,
      apply: async (ctx: Context, config: any) => {
        const setupContext: PluginSetupContext = {
          manifest: definition.manifest,
          getDependency: <T>(pluginId: string) => {
            if (!(definition.manifest.dependencies ?? []).some((dependency) => dependency.id === pluginId)) {
              throw new PluginRuntimeError(
                'MISSING_DEPENDENCY',
                `插件 ${definition.manifest.id} 未声明依赖 ${pluginId}`,
              );
            }
            return this.getService<T>(record, pluginId);
          },
          contribute: (kind, id, value) => {
            if (!declared.has(contributionKey(kind, id))) {
              throw new PluginRuntimeError(
                'UNDECLARED_CONTRIBUTION',
                `插件 ${definition.manifest.id} 注册了 manifest 未声明的 ${kind} 能力 ${id}`,
              );
            }
            const unregister = record.catalog.register(kind, id, definition.manifest.id, value);
            ctx.effect(() => unregister, `runforge-contribution:${kind}:${id}`);
          },
          effect: (setup, label) => {
            ctx.effect(setup, label ?? `runforge-plugin:${definition.manifest.id}`);
          },
        };

        const result = await definition.setup?.(setupContext, config);
        record.services.set(definition.manifest.id, result?.service);
        // service 本身仅作 Cordis 依赖激活信号，实际读取仍经过空间内的 service map。
        ctx.reflect.provide(serviceName(definition.manifest.id), result?.service);
        return async () => {
          record.services.delete(definition.manifest.id);
          await result?.dispose?.();
        };
      },
    };
  }

  private createRunPlugin(
    runId: string,
    record: SpaceRuntimeRecord,
    catalog: CapabilityCatalogSnapshot,
  ): Plugin<{}> {
    const selections = new Map(record.lock.plugins.map((selection) => [selection.id, selection]));
    return {
      name: `runforge-run:${runId}`,
      apply: async (ctx) => {
        for (const definition of record.orderedDefinitions) {
          if (!definition.activateRun) continue;
          const allowedServices = new Set([
            definition.manifest.id,
            ...(definition.manifest.dependencies ?? []).map((dependency) => dependency.id),
          ]);
          const runContext: PluginRunContext = {
            runId,
            manifest: definition.manifest,
            catalog,
            getPluginService: <T>(pluginId: string) => {
              if (!allowedServices.has(pluginId)) {
                throw new PluginRuntimeError(
                  'MISSING_DEPENDENCY',
                  `插件 ${definition.manifest.id} 的 run hook 未声明依赖 ${pluginId}`,
                );
              }
              return this.getService<T>(record, pluginId);
            },
            effect: (setup, label) => {
              ctx.effect(setup, label ?? `runforge-run:${runId}:${definition.manifest.id}`);
            },
          };
          const dispose = await definition.activateRun(runContext, selections.get(definition.manifest.id)!.config);
          if (dispose) ctx.effect(() => dispose, `runforge-run-hook:${definition.manifest.id}`);
        }
      },
    };
  }

  private getService<T>(record: SpaceRuntimeRecord, pluginId: string): T {
    if (!record.services.has(pluginId)) {
      throw new PluginRuntimeError('MISSING_DEPENDENCY', `空间运行时没有活动的插件服务 ${pluginId}`);
    }
    return record.services.get(pluginId) as T;
  }

  private view(record: SpaceRuntimeRecord): SpaceRuntimeView {
    return {
      lock: record.lock,
      catalog: record.catalog.snapshot(),
    };
  }

  private async collectRuntime(record: SpaceRuntimeRecord): Promise<void> {
    if (record.current || record.activeRuns > 0) return;
    await this.disposeRuntime(record);
  }

  private async disposeRuntime(record: SpaceRuntimeRecord): Promise<void> {
    if (record.disposing) return record.disposing;
    record.disposing = (async () => {
      await record.fiber.dispose();
      if (this.runtimes.get(record.key) === record) this.runtimes.delete(record.key);
    })();
    return record.disposing;
  }

  private assertActive(): void {
    if (this.disposed) throw new PluginRuntimeError('RUNTIME_DISPOSED', 'Cordis runtime manager 已释放');
  }
}
