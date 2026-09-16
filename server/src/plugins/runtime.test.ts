import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { PluginRuntimeError } from './errors.js';
import { CordisRuntimeManager } from './runtime.js';
import type {
  JsonValue,
  RunForgePluginDefinition,
  SpacePluginSelection,
  SpaceRuntimeConfig,
  SpaceRuntimeLock,
} from './types.js';

function contentHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function selection<T>(definition: RunForgePluginDefinition<T, unknown>, config: JsonValue): SpacePluginSelection {
  return {
    id: definition.manifest.id,
    version: definition.manifest.version,
    contentHash: definition.manifest.contentHash,
    config,
  };
}

function spaceConfig(
  spaceId: string,
  configVersion: number,
  plugins: SpacePluginSelection[],
): SpaceRuntimeConfig {
  return { tenantId: 'tenant-test', spaceId, configVersion, plugins };
}

function assertPluginError(error: unknown, code: PluginRuntimeError['code']): boolean {
  assert.equal(error instanceof PluginRuntimeError, true);
  assert.equal((error as PluginRuntimeError).code, code);
  return true;
}

test('Cordis runtime: 两个并发空间隔离插件配置、service 和 MCP 目录', async () => {
  const manager = new CordisRuntimeManager();
  const seenRuns: string[] = [];
  const plugin: RunForgePluginDefinition<{ label: string; mcpUrl: string }, { label: string }> = {
    manifest: {
      id: 'demo',
      version: '1.0.0',
      contentHash: contentHash('demo@1'),
      contributions: [
        { kind: 'mcp', id: 'demo.remote' },
        { kind: 'skill', id: 'demo-guide' },
        { kind: 'capability', id: 'demo.lookup' },
      ],
    },
    configSchema: z.object({ label: z.string(), mcpUrl: z.string().url() }),
    setup(context, config) {
      context.contribute('mcp', 'demo.remote', { url: config.mcpUrl });
      context.contribute('skill', 'demo-guide', { label: config.label });
      context.contribute('capability', 'demo.lookup', { label: config.label });
      return { service: { label: config.label } };
    },
    activateRun(context) {
      const service = context.getPluginService<{ label: string }>('demo');
      seenRuns.push(`${context.runId}:${service.label}`);
    },
  };
  manager.registerPlugin(plugin);
  const consumer: RunForgePluginDefinition<Record<string, never>> = {
    manifest: {
      id: 'consumer',
      version: '1.0.0',
      contentHash: contentHash('consumer@1'),
      dependencies: [{ id: 'demo', version: '1.0.0' }],
      contributions: [{ kind: 'tool', id: 'consumer.search' }],
    },
    configSchema: z.object({}),
    setup(context) {
      const dependency = context.getDependency<{ label: string }>('demo');
      context.contribute('tool', 'consumer.search', { label: dependency.label });
    },
  };
  manager.registerPlugin(consumer);

  try {
    const [leftSpace, rightSpace] = await Promise.all([
      manager.activateSpace(spaceConfig('sp_left', 1, [
        selection(plugin, { label: 'left', mcpUrl: 'https://left.example/mcp' }),
        selection(consumer, {}),
      ])),
      manager.activateSpace(spaceConfig('sp_right', 1, [
        selection(plugin, { label: 'right', mcpUrl: 'https://right.example/mcp' }),
        selection(consumer, {}),
      ])),
    ]);
    const [leftRun, rightRun] = await Promise.all([
      manager.startRun('ru_left', leftSpace.lock),
      manager.startRun('ru_right', rightSpace.lock),
    ]);

    assert.deepEqual(leftRun.getPluginService<{ label: string }>('demo'), { label: 'left' });
    assert.deepEqual(rightRun.getPluginService<{ label: string }>('demo'), { label: 'right' });
    assert.deepEqual(leftRun.catalog.mcpServers[0]?.value, { url: 'https://left.example/mcp' });
    assert.deepEqual(rightRun.catalog.mcpServers[0]?.value, { url: 'https://right.example/mcp' });
    assert.deepEqual(leftRun.catalog.tools[0]?.value, { label: 'left' });
    assert.deepEqual(rightRun.catalog.tools[0]?.value, { label: 'right' });
    assert.deepEqual(leftRun.catalog.skills[0]?.value, { label: 'left' });
    assert.deepEqual(rightRun.catalog.skills[0]?.value, { label: 'right' });
    assert.deepEqual(seenRuns.sort(), ['ru_left:left', 'ru_right:right']);

    await Promise.all([leftRun.dispose(), rightRun.dispose()]);
  } finally {
    await manager.dispose();
  }
});

test('Cordis runtime: run 子上下文释放定时器、监听器、连接和 hook 返回资源', async () => {
  const manager = new CordisRuntimeManager();
  const emitter = new EventEmitter();
  let timerDisposed = 0;
  let connectionDisposed = 0;
  let hookDisposed = 0;
  const plugin: RunForgePluginDefinition<Record<string, never>> = {
    manifest: {
      id: 'lifecycle',
      version: '1.0.0',
      contentHash: contentHash('lifecycle@1'),
    },
    configSchema: z.object({}),
    activateRun(context) {
      const timer = setInterval(() => undefined, 60_000);
      timer.unref();
      const listener = () => undefined;
      emitter.on('message', listener);
      context.effect(() => () => {
        clearInterval(timer);
        timerDisposed += 1;
      }, '测试定时器');
      context.effect(() => () => {
        emitter.off('message', listener);
      }, '测试监听器');
      context.effect(() => async () => {
        connectionDisposed += 1;
      }, '测试连接');
      return () => {
        hookDisposed += 1;
      };
    },
  };
  manager.registerPlugin(plugin);

  try {
    const lock = manager.createLock(spaceConfig('sp_lifecycle', 1, [selection(plugin, {})]));
    const run = await manager.startRun('ru_lifecycle', lock);
    assert.equal(emitter.listenerCount('message'), 1);
    await run.dispose();
    assert.equal(emitter.listenerCount('message'), 0);
    assert.equal(timerDisposed, 1);
    assert.equal(connectionDisposed, 1);
    assert.equal(hookDisposed, 1);
    await run.dispose();
    assert.equal(timerDisposed, 1);
  } finally {
    await manager.dispose();
  }
});

test('Cordis runtime: 依赖缺失、循环、版本不匹配和能力冲突在插件启动前失败', async () => {
  let setupCount = 0;
  const manager = new CordisRuntimeManager();
  const makePlugin = (
    id: string,
    dependencies: RunForgePluginDefinition['manifest']['dependencies'] = [],
    toolId?: string,
  ): RunForgePluginDefinition<Record<string, never>> => ({
    manifest: {
      id,
      version: '1.0.0',
      contentHash: contentHash(`${id}@1`),
      dependencies,
      contributions: toolId ? [{ kind: 'tool', id: toolId }] : [],
    },
    configSchema: z.object({}),
    setup() {
      setupCount += 1;
    },
  });
  const missing = makePlugin('missing-user', [{ id: 'not-selected' }]);
  const cycleA = makePlugin('cycle-a', [{ id: 'cycle-b' }]);
  const cycleB = makePlugin('cycle-b', [{ id: 'cycle-a' }]);
  const wrongVersion = makePlugin('version-user', [{ id: 'base', version: '2.0.0' }]);
  const base = makePlugin('base');
  const conflictA = makePlugin('conflict-a', [], 'shared-tool');
  const conflictB = makePlugin('conflict-b', [], 'shared-tool');
  for (const plugin of [missing, cycleA, cycleB, wrongVersion, base, conflictA, conflictB]) {
    manager.registerPlugin(plugin);
  }

  try {
    assert.throws(
      () => manager.createLock(spaceConfig('sp_missing', 1, [selection(missing, {})])),
      (error) => assertPluginError(error, 'MISSING_DEPENDENCY'),
    );
    assert.throws(
      () => manager.createLock(spaceConfig('sp_cycle', 1, [selection(cycleA, {}), selection(cycleB, {})])),
      (error) => assertPluginError(error, 'DEPENDENCY_CYCLE'),
    );
    assert.throws(
      () => manager.createLock(spaceConfig('sp_version', 1, [selection(base, {}), selection(wrongVersion, {})])),
      (error) => assertPluginError(error, 'DEPENDENCY_VERSION_MISMATCH'),
    );
    assert.throws(
      () => manager.createLock(spaceConfig('sp_conflict', 1, [selection(conflictA, {}), selection(conflictB, {})])),
      (error) => assertPluginError(error, 'CONTRIBUTION_CONFLICT'),
    );
    assert.equal(setupCount, 0);
  } finally {
    await manager.dispose();
  }
});

test('Cordis runtime: 配置锁稳定、不可变且能发现持久化内容被篡改', async () => {
  const manager = new CordisRuntimeManager();
  const plugin: RunForgePluginDefinition<{ nested: { a: number; b: number } }> = {
    manifest: { id: 'lock', version: '1.0.0', contentHash: contentHash('lock@1') },
    configSchema: z.object({ nested: z.object({ a: z.number(), b: z.number() }) }),
  };
  manager.registerPlugin(plugin);

  try {
    const left = manager.createLock(spaceConfig('sp_lock', 7, [selection(plugin, {
      nested: { b: 2, a: 1 },
    })]));
    const right = manager.createLock(spaceConfig('sp_lock', 7, [selection(plugin, {
      nested: { a: 1, b: 2 },
    })]));
    assert.equal(left.hash, right.hash);
    assert.equal(Object.isFrozen(left), true);
    assert.equal(Object.isFrozen(left.plugins[0]?.config), true);

    const tampered = JSON.parse(JSON.stringify(left)) as SpaceRuntimeLock;
    tampered.plugins[0]!.config = { nested: { a: 9, b: 2 } };
    await assert.rejects(
      () => manager.startRun('ru_tampered', tampered),
      (error) => assertPluginError(error, 'LOCK_HASH_MISMATCH'),
    );
  } finally {
    await manager.dispose();
  }
});

test('Cordis runtime: 当前版本切换后保留活动 run 的旧插件，并可按旧锁恢复', async () => {
  const manager = new CordisRuntimeManager();
  const active = new Map<string, number>();
  const makeVersion = (version: string): RunForgePluginDefinition<Record<string, never>, { version: string }> => ({
    manifest: { id: 'versioned', version, contentHash: contentHash(`versioned@${version}`) },
    configSchema: z.object({}),
    setup() {
      active.set(version, (active.get(version) ?? 0) + 1);
      return {
        service: { version },
        dispose: () => {
          active.set(version, (active.get(version) ?? 1) - 1);
        },
      };
    },
  });
  const version1 = makeVersion('1.0.0');
  const version2 = makeVersion('2.0.0');
  manager.registerPlugin(version1);
  manager.registerPlugin(version2);

  try {
    const oldSpace = await manager.activateSpace(spaceConfig('sp_versioned', 1, [selection(version1, {})]));
    const oldRun = await manager.startRun('ru_old', oldSpace.lock);
    assert.equal(oldRun.getPluginService<{ version: string }>('versioned').version, '1.0.0');

    const newSpace = await manager.activateSpace(spaceConfig('sp_versioned', 2, [selection(version2, {})]));
    assert.equal(active.get('1.0.0'), 1);
    assert.equal(active.get('2.0.0'), 1);

    await oldRun.dispose();
    assert.equal(active.get('1.0.0'), 0);

    const recovered = await manager.startRun('ru_recovered', oldSpace.lock);
    assert.equal(recovered.getPluginService<{ version: string }>('versioned').version, '1.0.0');
    assert.equal(active.get('1.0.0'), 1);
    await recovered.dispose();
    assert.equal(active.get('1.0.0'), 0);
    assert.equal(newSpace.lock.configVersion, 2);
    await manager.deactivateSpace('tenant-test', 'sp_versioned');
    assert.equal(active.get('2.0.0'), 0);
  } finally {
    await manager.dispose();
  }
  assert.equal(active.get('2.0.0'), 0);
});

test('Cordis runtime: manifest 未声明的动态能力不能绕过启动校验', async () => {
  const manager = new CordisRuntimeManager();
  let disposed = 0;
  const plugin: RunForgePluginDefinition<Record<string, never>> = {
    manifest: { id: 'undeclared', version: '1.0.0', contentHash: contentHash('undeclared@1') },
    configSchema: z.object({}),
    setup(context) {
      context.effect(() => () => {
        disposed += 1;
      }, '失败启动清理验证');
      context.contribute('tool', 'undeclared.hidden', {});
    },
  };
  manager.registerPlugin(plugin);
  try {
    await assert.rejects(
      () => manager.activateSpace(spaceConfig('sp_undeclared', 1, [selection(plugin, {})])),
      (error) => assertPluginError(error, 'UNDECLARED_CONTRIBUTION'),
    );
    assert.equal(disposed, 1);
  } finally {
    await manager.dispose();
  }
});
