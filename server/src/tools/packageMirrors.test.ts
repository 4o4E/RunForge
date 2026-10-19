import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { getSystemToolSettings, normalizeToolSettings, saveToolSettings } from '../settings.js';
import { shellManager } from '../shell/manager.js';
import { shellBus } from '../shell/bus.js';
import { store } from '../store/index.js';
import type { AgentEvent } from '../agent/types.js';
import type { Scope } from '../store/types.js';
import type { ToolResult } from './types.js';
import { shellTool } from './shell.js';

function waitForShellEvent(threadId: string, predicate: (event: AgentEvent) => boolean, signal: AbortSignal) {
  let resolveEvent!: () => void;
  let rejectEvent!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => { resolveEvent = resolve; rejectEvent = reject; });
  const dispose = () => {
    unsubscribe();
    signal.removeEventListener('abort', abort);
  };
  const unsubscribe = shellBus.subscribe(threadId, (event) => {
    if (!predicate(event)) return;
    dispose();
    resolveEvent();
  });
  const abort = () => { dispose(); rejectEvent(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  void promise.catch(() => undefined);
  return { promise, dispose };
}

const text = (result: string | ToolResult): string => typeof result === 'string' ? result : result.text;

test('普通 shell 与旧托管会话的新命令使用最新镜像源，已启动进程保留原环境', { timeout: 40_000 }, async (t) => {
  const original = await getSystemToolSettings();
  const originalRoot = config.tools.workspaceRoot;
  const previousSecret = process.env.RUNFORGE_BACKEND_SECRET;
  const dir = await mkdtemp(join(tmpdir(), 'runforge-package-mirrors-'));
  const scope: Scope = { tenantId: 'default', userId: 'us_package_mirrors' };
  config.tools.workspaceRoot = dir;
  process.env.RUNFORGE_BACKEND_SECRET = 'backend-only-value';
  const printEnv = '[ -z "${RUNFORGE_BACKEND_SECRET+x}" ] || exit 41; printf "%s\\n" "$PIP_INDEX_URL" "$UV_DEFAULT_INDEX" "$NPM_CONFIG_REGISTRY" "$PNPM_CONFIG_REGISTRY"; printf "isolation-ok\\nexplicit=%s\\n" "$EXPLICIT_VALUE"';
  const first = { pipIndexUrl: 'https://first.example.com/simple', npmRegistry: 'https://first.example.com/npm/' };
  const second = { pipIndexUrl: 'https://second.example.com/simple', npmRegistry: 'https://second.example.com/npm/' };
  const expected = (mirrors: typeof first) => [
    mirrors.pipIndexUrl, mirrors.pipIndexUrl,
    mirrors.npmRegistry, mirrors.npmRegistry, 'isolation-ok', 'explicit=retained',
  ].join('\n');
  try {
    for (const useHostPath of process.platform === 'linux' ? [true, false] : [true]) {
      await t.test(useHostPath ? '容器范围' : '会话隔离', async () => {
        const workspaceRoot = join(dir, useHostPath ? 'container' : 'isolated');
        await mkdir(workspaceRoot, { recursive: true });
        await writeFile(join(workspaceRoot, '.npmrc'), 'registry=https://project.example.com/npm/\n');
        await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'registry: https://project.example.com/pnpm/\n');
        await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({ private: true, scripts: { registry: 'npm config get registry' } }));
        await saveToolSettings(scope, { ...original, ...first });
        const settings = normalizeToolSettings({
          ...original, ...first, workspaceRoot, sandbox: 'enforce',
          sandboxBackend: useHostPath ? 'none' : 'bwrap', shellUseHostPath: useHostPath,
        });
        // 系统配置在进程启动边界覆盖旧环境，但保留调用方明确传入的其他运行变量。
        const env = { EXPLICIT_VALUE: 'retained', PIP_INDEX_URL: 'https://stale.example.com', NPM_CONFIG_REGISTRY: 'https://stale.example.com' };
        assert.equal(text(await shellTool.run({ command: printEnv }, { scope, settings, env })), expected(first));
        const thread = await store.createThread(scope);
        const session = await shellManager.openSession({ scope, threadId: thread.id, settings, owner: 'system', name: 'Default' });
        const gate = join(workspaceRoot, 'release');
        const ready = waitForShellEvent(thread.id, (event) => event.type === 'shell_command_output' && event.text.includes('mirror-ready'), t.signal);
        let commandId = '';
        const finished = waitForShellEvent(thread.id, (event) => event.type === 'shell_command_finished' && event.commandId === commandId, t.signal);
        try {
          const running = await shellManager.exec({
            scope, sessionId: session.id, settings, env,
            context: { threadId: thread.id }, actor: 'user', waitMode: 'background',
            command: `printf 'mirror-ready\\n'; while [ ! -f '${gate}' ]; do sleep 0.01; done; ${printEnv}`,
          });
          commandId = running.command.id;
          await ready.promise;
          await saveToolSettings(scope, { ...original, ...second });
          await writeFile(gate, 'release');
          await finished.promise;
          const old = await shellManager.poll(scope, commandId);
          assert.equal(old.command?.status, 'succeeded');
          assert.ok(old.logs.map((entry) => entry.chunk).join('').includes(expected(first)));
          assert.equal(text(await shellTool.run({ command: printEnv }, { scope, settings, env })), expected(second));
          const registries = text(await shellTool.run({
            command: 'npm config get registry && npm run --silent registry && pnpm config get registry',
          }, { scope, settings, env }));
          assert.deepEqual(registries.split(/\r?\n/), [second.npmRegistry, second.npmRegistry, second.npmRegistry]);
          const manual = await shellManager.exec({
            scope, sessionId: session.id, settings, env, context: { threadId: thread.id }, actor: 'user',
            command: printEnv, waitMode: 'foreground', waitTimeoutMs: 10_000,
          });
          assert.equal(manual.command.status, 'succeeded');
          assert.equal(manual.tail.trim(), expected(second));
          const agent = text(await shellTool.run({ command: printEnv }, { scope, settings, env, threadId: thread.id }));
          assert.ok(agent.includes(expected(second)));
        } finally {
          ready.dispose();
          finished.dispose();
          await writeFile(gate, 'release');
          if (commandId) await shellManager.kill(scope, commandId, 'test_cleanup');
        }
      });
    }
  } finally {
    await shellManager.shutdown();
    await saveToolSettings(scope, original);
    config.tools.workspaceRoot = originalRoot;
    if (previousSecret === undefined) delete process.env.RUNFORGE_BACKEND_SECRET;
    else process.env.RUNFORGE_BACKEND_SECRET = previousSecret;
    await rm(dir, { recursive: true, force: true });
  }
});
