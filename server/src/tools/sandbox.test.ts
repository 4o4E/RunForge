import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  buildBwrapArgs,
  buildShellSpawnSpec,
  describeShellSandbox,
  findExecutable,
  parentDirs,
  runShellCommand,
} from './sandbox.js';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('findExecutable resolves executable from a supplied PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runforge-sandbox-'));
  tempDirs.push(dir);
  const bin = join(dir, 'allowed');
  await writeFile(bin, '#!/bin/sh\n');
  await chmod(bin, 0o755);

  assert.equal(findExecutable('allowed', dir), bin);
  assert.equal(findExecutable('missing', dir), undefined);
});

test('parentDirs returns mount parents from shallow to deep', () => {
  assert.deepEqual(parentDirs('/root/projects/RunForge'), ['/root', '/root/projects']);
});

test('buildShellSpawnSpec preserves the configured PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runforge-sandbox-'));
  tempDirs.push(dir);
  const spec = buildShellSpawnSpec('true', {
    policyMode: 'off',
    backend: 'none',
    workspaceRoot: dir,
    useHostPath: false,
    envPath: dir,
    shareNet: false,
  });
  assert.equal(spec.backend, 'host');
  assert.equal(spec.env?.PATH, dir);

  const hostSpec = buildShellSpawnSpec('true', {
    policyMode: 'off',
    backend: 'none',
    workspaceRoot: dir,
    useHostPath: true,
    envPath: dir,
    shareNet: false,
  });
  assert.equal(hostSpec.backend, 'host');
  assert.equal(hostSpec.env?.PATH, dir);
});

test('业务插件命令门面按声明顺序优先于系统命令，并且只暴露声明名称', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'runforge-plugin-path-'));
  tempDirs.push(workspace);
  const pluginDir = join(workspace, 'plugins', 'first', 'bin');
  await mkdir(pluginDir, { recursive: true });
  const command = join(pluginDir, 'ffmpeg');
  await writeFile(command, '#!/bin/sh\nprintf plugin\n');
  await chmod(command, 0o755);
  const spec = buildShellSpawnSpec('ffmpeg', {
    policyMode: 'off',
    backend: 'none',
    workspaceRoot: workspace,
    useHostPath: false,
    envPath: '',
    shareNet: false,
    pluginExecutables: [{ name: 'ffmpeg', path: command }],
  });
  assert.equal(spec.backend, 'host');
  const { stdout } = await execFileAsync(spec.file, spec.args, { env: spec.env });
  assert.equal(stdout, 'plugin');
  await Promise.all((spec.cleanupPaths ?? []).map((path) => rm(path, { recursive: true, force: true })));
});

test('buildBwrapArgs confines workspace and hides network by default', () => {
  const workspaceRoot = resolve('/workspace/app');
  const args = buildBwrapArgs({
    workspaceRoot,
    command: 'cat package.json',
    shareNet: false,
  });

  assert.ok(args.includes('--unshare-all'));
  assert.equal(args.includes('--share-net'), false);
  assert.deepEqual(args.slice(args.indexOf('--bind'), args.indexOf('--bind') + 3), ['--bind', workspaceRoot, workspaceRoot]);
  assert.deepEqual(args.slice(args.indexOf('--chdir'), args.indexOf('--chdir') + 2), ['--chdir', workspaceRoot]);
  assert.match(args[args.indexOf('--setenv') + 2] ?? '', /\/bin|\/usr\/bin/);
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'cat package.json']);
});

test('bwrap 单独挂载当前用户目录，不挂载其他用户目录', () => {
  const workspaceRoot = resolve('/w/sp_test/c/th_test');
  const userFiles = { source: resolve('/u/us_owner'), mountPath: resolve('/u/us_owner') };
  const args = buildBwrapArgs({ workspaceRoot, command: 'pwd', shareNet: false, userFiles });
  const pairs = args.flatMap((arg, index) => arg === '--bind' ? [`${args[index + 1]}:${args[index + 2]}`] : []);
  assert.ok(pairs.includes(`${userFiles.source}:${userFiles.mountPath}`));
  assert.ok(!pairs.includes('/u:/u'));
  assert.ok(!pairs.some((pair) => pair.includes('us_other')));
});

test('真实 bwrap 允许当前用户文件，隐藏其他用户文件', async () => {
  if (process.platform !== 'linux') return;
  const base = await mkdtemp(join(tmpdir(), 'runforge-user-bwrap-'));
  tempDirs.push(base);
  const workspaceRoot = join(base, 'w', 'sp_test', 'c', 'th_test');
  const own = join(base, 'u', 'us_owner');
  const other = join(base, 'u', 'us_other');
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(own, { recursive: true }), mkdir(other, { recursive: true })]);
  await writeFile(join(own, 'note.txt'), 'owner-data');
  await writeFile(join(other, 'secret.txt'), 'other-data');
  const result = await runShellCommand(`cat '${join(own, 'note.txt')}' && test ! -e '${join(other, 'secret.txt')}'`, 10_000, {
    policyMode: 'enforce', backend: 'bwrap', workspaceRoot,
    useHostPath: false, shareNet: false,
    userFiles: { source: own, mountPath: own },
  });
  assert.equal(result.stdout, 'owner-data');
});

test('buildBwrapArgs can explicitly share network namespace', () => {
  const args = buildBwrapArgs({
    workspaceRoot: resolve('/workspace/app'),
    command: 'printf ok',
    shareNet: true,
  });

  assert.ok(args.includes('--share-net'));
  assert.ok(args.includes('/etc/resolv.conf'));
  assert.ok(args.includes('/etc/ssl/certs') || args.includes('/usr/share/ca-certificates'));
});

test('bwrap 只为业务插件声明命令建立 symlink 门面', () => {
  const args = buildBwrapArgs({
    workspaceRoot: resolve('/workspace/app'),
    command: 'ffmpeg -version',
    shareNet: false,
    pluginExecutables: [{ name: 'ffmpeg', path: '/workspace/app/plugins/media/bin/ffmpeg' }],
  });
  const symlinkIndex = args.indexOf('--symlink');
  assert.deepEqual(args.slice(symlinkIndex, symlinkIndex + 3), [
    '--symlink',
    '/workspace/app/plugins/media/bin/ffmpeg',
    '/runforge/plugin-bin/ffmpeg',
  ]);
  assert.match(args[args.indexOf('--setenv') + 2] ?? '', /^\/runforge\/plugin-bin:/);
});

test('真实 bwrap 可以通过命令门面执行插件文件', async () => {
  if (process.platform !== 'linux') return;
  const workspace = await mkdtemp(join(tmpdir(), 'runforge-plugin-bwrap-'));
  const snapshot = await mkdtemp(join(tmpdir(), 'runforge-plugin-snapshot-'));
  tempDirs.push(workspace, snapshot);
  const snapshotBin = join(snapshot, 'bin');
  await mkdir(snapshotBin, { recursive: true });
  await writeFile(join(snapshotBin, 'helper'), '#!/bin/sh\nprintf bwrap-plugin\n');
  await chmod(join(snapshotBin, 'helper'), 0o755);
  const pluginRoot = join(workspace, 'plugins', 'media');
  await mkdir(dirname(pluginRoot), { recursive: true });
  await symlink(relative(dirname(pluginRoot), snapshot), pluginRoot, 'dir');
  const command = join(pluginRoot, 'bin', 'helper');
  const result = await runShellCommand('helper', 10_000, {
    policyMode: 'enforce',
    backend: 'bwrap',
    workspaceRoot: workspace,
    useHostPath: false,
    shareNet: false,
    pluginExecutables: [{ name: 'helper', path: command }],
    pluginRoots: [pluginRoot],
  });
  assert.equal(result.stdout.trim(), 'bwrap-plugin');
});

test('bwrap 只读挂载当前空间资源与锁定插件，不暴露相邻会话', async () => {
  if (process.platform !== 'linux') return;
  const base = await mkdtemp(join(tmpdir(), 'runforge-space-bwrap-'));
  const snapshot = await mkdtemp(join(tmpdir(), 'runforge-space-snapshot-'));
  tempDirs.push(base, snapshot);
  const spaceRoot = join(base, 'sp_test');
  const workspaceRoot = join(spaceRoot, 'c', 'th_test');
  const siblingRoot = join(spaceRoot, 'c', 'th_other');
  const selectedSkill = join(spaceRoot, '.skills', 'builtin', 'demo', 'selected');
  const oldSkill = join(spaceRoot, '.skills', 'builtin', 'old', 'unselected');
  const pluginLink = join(spaceRoot, '.plugins', 'demo', 'hash');
  await mkdir(selectedSkill, { recursive: true });
  await mkdir(oldSkill, { recursive: true });
  await mkdir(join(workspaceRoot, '.agents', 'skills'), { recursive: true });
  await mkdir(join(workspaceRoot, 'plugins'), { recursive: true });
  await mkdir(dirname(pluginLink), { recursive: true });
  await mkdir(siblingRoot, { recursive: true });
  await writeFile(join(selectedSkill, 'SKILL.md'), 'selected-skill');
  await writeFile(join(oldSkill, 'SKILL.md'), 'old-skill');
  await writeFile(join(snapshot, 'manifest.txt'), 'selected-plugin');
  await writeFile(join(siblingRoot, 'secret.txt'), 'sibling-secret');
  const skillEntry = join(workspaceRoot, '.agents', 'skills', 'demo');
  await symlink(relative(dirname(skillEntry), selectedSkill), skillEntry, 'dir');
  const oldEntry = join(workspaceRoot, '.agents', 'skills', 'old');
  await symlink(relative(dirname(oldEntry), oldSkill), oldEntry, 'dir');
  await symlink(relative(dirname(pluginLink), snapshot), pluginLink, 'dir');
  const pluginEntry = join(workspaceRoot, 'plugins', 'demo');
  await symlink(relative(dirname(pluginEntry), pluginLink), pluginEntry, 'dir');

  const result = await runShellCommand(
    'cat .agents/skills/demo/SKILL.md plugins/demo/manifest.txt; if [ -e .agents/skills/old/SKILL.md ] || [ -e ../th_other/secret.txt ]; then echo leaked; else echo isolated; fi',
    10_000,
    {
      policyMode: 'enforce', backend: 'bwrap', workspaceRoot, spaceRoot,
      useHostPath: false, shareNet: false,
      managedReadRoots: [skillEntry], pluginRoots: [pluginEntry],
    },
  );
  assert.match(result.stdout, /selected-skillselected-plugin/);
  assert.match(result.stdout, /isolated/);
  await assert.rejects(runShellCommand('printf changed > .agents/skills/demo/SKILL.md', 10_000, {
    policyMode: 'enforce', backend: 'bwrap', workspaceRoot, spaceRoot,
    useHostPath: false, shareNet: false,
    managedReadRoots: [skillEntry], pluginRoots: [pluginEntry],
  }));
  assert.equal(await readFile(join(selectedSkill, 'SKILL.md'), 'utf8'), 'selected-skill');
});

test('bwrap 只挂载当前 run 明确选择的业务插件链接目标', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'runforge-plugin-roots-'));
  const selectedSnapshot = await mkdtemp(join(tmpdir(), 'runforge-plugin-selected-'));
  const unselectedSnapshot = await mkdtemp(join(tmpdir(), 'runforge-plugin-unselected-'));
  tempDirs.push(workspace, selectedSnapshot, unselectedSnapshot);
  const pluginsRoot = join(workspace, 'plugins');
  await mkdir(pluginsRoot, { recursive: true });
  const selectedRoot = join(pluginsRoot, 'selected');
  const unselectedRoot = join(pluginsRoot, 'unselected');
  await symlink(relative(pluginsRoot, selectedSnapshot), selectedRoot, 'dir');
  await symlink(relative(pluginsRoot, unselectedSnapshot), unselectedRoot, 'dir');

  const args = buildBwrapArgs({
    workspaceRoot: workspace,
    command: 'true',
    shareNet: false,
    pluginRoots: [selectedRoot],
  });

  assert.equal(args.includes(selectedSnapshot), true);
  assert.equal(args.includes(unselectedSnapshot), false);
});

test('buildBwrapArgs mounts system commands from container PATH', () => {
  const args = buildBwrapArgs({
    workspaceRoot: resolve('/workspace/app'),
    command: 'git init repo',
    shareNet: false,
  });

  assert.deepEqual(args.slice(args.indexOf('--ro-bind'), args.indexOf('--ro-bind') + 3), ['--ro-bind', '/usr', '/usr']);
});

test('真实 bwrap 可直接执行 PATH 中的常用文件命令', async () => {
  if (process.platform !== 'linux') return;
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-path-'));
  tempDirs.push(workspaceRoot);
  const result = await runShellCommand('touch note.txt && mkdir output && cp note.txt output/copy.txt && test -f output/copy.txt && printf ok', 10_000, {
    policyMode: 'enforce', backend: 'bwrap', workspaceRoot, useHostPath: false, shareNet: false,
  });
  assert.equal(result.stdout, 'ok');
});

test('真实 bwrap 保留管理员设置的自定义 PATH', async () => {
  if (process.platform !== 'linux') return;
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-custom-path-workspace-'));
  const binDir = await mkdtemp(join(tmpdir(), 'runforge-custom-path-bin-'));
  const aliasRoot = await mkdtemp(join(tmpdir(), 'runforge-custom-path-alias-'));
  tempDirs.push(workspaceRoot, binDir, aliasRoot);
  const commandPath = join(binDir, 'custom-command');
  await writeFile(commandPath, '#!/bin/sh\nprintf custom-path');
  await chmod(commandPath, 0o755);
  const alias = join(aliasRoot, 'bin');
  await symlink(binDir, alias, 'dir');
  for (const path of [binDir, alias]) {
    const result = await runShellCommand('custom-command', 10_000, {
      policyMode: 'enforce', backend: 'bwrap', workspaceRoot, useHostPath: false,
      envPath: `${path}:/usr/bin:/bin`, shareNet: false,
    });
    assert.equal(result.stdout, 'custom-path');
  }
});

test('bwrap 拒绝通过自定义 PATH 投射其他用户目录', () => {
  assert.throws(() => buildBwrapArgs({
    workspaceRoot: '/w/sp_test/c/th_test',
    command: 'pwd',
    shareNet: false,
    envPath: '/u/us_other/bin:/usr/bin',
  }), /PATH 不能挂载/);
});

test('bwrap 拒绝通过自定义 PATH 投射容器根目录及其符号链接', async () => {
  if (process.platform !== 'linux') return;
  const aliasRoot = await mkdtemp(join(tmpdir(), 'runforge-path-alias-'));
  tempDirs.push(aliasRoot);
  const rootLink = join(aliasRoot, 'root');
  await symlink('/', rootLink, 'dir');
  for (const envPath of ['/', rootLink]) {
    assert.throws(() => buildBwrapArgs({
      workspaceRoot: '/w/sp_test/c/th_test',
      command: 'pwd',
      shareNet: false,
      envPath,
    }), /PATH 不能挂载/);
  }
});

test('describeShellSandbox reports effective shell mode', () => {
  assert.equal(
    describeShellSandbox({
      policyMode: 'off',
    backend: 'auto',
    workspaceRoot: '/workspace/app',
    useHostPath: false,
    shareNet: false,
  }),
    'host',
  );
  assert.equal(
    describeShellSandbox({
      policyMode: 'enforce',
      backend: 'bwrap',
      workspaceRoot: '/workspace/app',
      useHostPath: false,
    shareNet: false,
  }),
    'bwrap, net: disabled',
  );
  assert.equal(
    describeShellSandbox({
      policyMode: 'enforce',
      backend: 'bwrap',
      workspaceRoot: '/workspace/app',
      useHostPath: true,
      shareNet: false,
    }),
    'host (container PATH)',
  );
});
