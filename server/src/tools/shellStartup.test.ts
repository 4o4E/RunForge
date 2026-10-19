import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSystemToolSettings } from '../settings.js';
import { shellManager } from '../shell/manager.js';
import { store } from '../store/index.js';
import { runShellCommand } from './sandbox.js';

const scope = { tenantId: 'default', userId: 'us_shell_startup' };
const nodeDirectory = dirname(process.execPath);
const shellPath = `${nodeDirectory}:${dirname(nodeDirectory)}:/usr/local/bin:/usr/bin:/bin`;
after(async () => { await shellManager.shutdown(); });

test('两种范围的普通与托管 Shell 均不能从环境或 PID 1 读取后端变量', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-shell-env-'));
  const key = 'RUNFORGE_BACKEND_BOUNDARY_MARKER';
  const original = process.env[key];
  process.env[key] = 'backend-only-boundary-check';
  try {
    // 读取真实 PID 1 的初始环境，覆盖仅清空实际 Shell 环境仍会泄漏的路径。
    const program = `const fs=require('node:fs');const key=${JSON.stringify(key)};console.log(JSON.stringify({shell:Object.hasOwn(process.env,key),pid1:fs.readFileSync('/proc/1/environ').includes(Buffer.from(key+'='))}));`;
    await writeFile(join(root, 'environment.cjs'), program);
    const command = `"${process.execPath}" "${join(root, 'environment.cjs')}"`;
    for (const shellUseHostPath of [true, false]) {
      const settings = { ...await getSystemToolSettings(), workspaceRoot: root, sandboxBackend: 'auto' as const, shellUseHostPath, shellPathMode: 'custom' as const, shellPath };
      const direct = await runShellCommand(command, 10_000, {
        backend: settings.sandboxBackend, workspaceRoot: root, useHostPath: shellUseHostPath, envPath: shellPath, shareNet: false,
      });
      assert.deepEqual(JSON.parse(direct.stdout), { shell: false, pid1: false });
      const thread = await store.createThread(scope);
      const session = await shellManager.reuseSession({ scope, threadId: thread.id, settings });
      const managed = await shellManager.exec({ scope, sessionId: session.id, settings, command, context: { threadId: thread.id }, waitMode: 'foreground', waitTimeoutMs: 10_000 });
      assert.equal(managed.command.status, 'succeeded');
      assert.deepEqual(JSON.parse(managed.tail), { shell: false, pid1: false });
    }
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少 bwrap 的真实启动失败结束命令并释放会话，恢复 PATH 后可继续执行', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-shell-start-'));
  const originalPath = process.env.PATH!;
  try {
    const settings = { ...await getSystemToolSettings(), workspaceRoot: root, sandboxBackend: 'auto' as const, shellUseHostPath: true };
    const thread = await store.createThread(scope);
    const session = await shellManager.reuseSession({ scope, threadId: thread.id, settings });
    // PATH 指向不存在的目录，使真实 bwrap 查找失败；随后恢复 PATH 验证同一会话。
    process.env.PATH = join(root, 'no-programs');
    await assert.rejects(shellManager.exec({ scope, sessionId: session.id, settings, command: 'printf blocked', context: { threadId: thread.id } }), /bwrap/);
    process.env.PATH = originalPath;
    const [failed] = await store.listShellCommandsBySession(scope, session.id, 10);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /bwrap/);
    const released = await store.getShellSession(scope, session.id);
    assert.equal(released?.status, 'idle');
    assert.equal(released?.lease_actor, null);
    const recovered = await shellManager.exec({ scope, sessionId: session.id, settings, command: 'printf recovered', context: { threadId: thread.id }, waitMode: 'foreground', waitTimeoutMs: 10_000 });
    assert.equal(recovered.command.status, 'succeeded');
    assert.equal(recovered.tail, 'recovered');
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
