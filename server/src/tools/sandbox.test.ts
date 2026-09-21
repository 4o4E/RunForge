import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildBwrapArgs,
  buildShellSpawnSpec,
  describeShellSandbox,
  findExecutable,
  parentDirs,
  resolveAllowedCommands,
  scanExecutableNames,
} from './sandbox.js';

const tempDirs: string[] = [];

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

test('resolveAllowedCommands skips missing commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runforge-sandbox-'));
  tempDirs.push(dir);
  const bin = join(dir, 'present');
  await writeFile(bin, '#!/bin/sh\n');
  await chmod(bin, 0o755);

  const resolved = resolveAllowedCommands(['present', 'absent'], dir);
  assert.deepEqual(
    resolved.map((cmd) => cmd.name),
    ['present'],
  );
  assert.equal(resolved[0]?.dest, bin);
});

test('scanExecutableNames returns executable files from PATH directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runforge-sandbox-'));
  tempDirs.push(dir);
  const bin = join(dir, 'scan-me');
  const text = join(dir, 'skip-me');
  await writeFile(bin, '#!/bin/sh\n');
  await writeFile(text, 'not executable\n');
  await chmod(bin, 0o755);

  assert.deepEqual(scanExecutableNames(dir), ['scan-me']);
});

test('buildShellSpawnSpec limits host PATH to selected commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runforge-sandbox-'));
  tempDirs.push(dir);
  const allowed = join(dir, 'allowed');
  const hidden = join(dir, 'hidden');
  await writeFile(allowed, '#!/bin/sh\n');
  await writeFile(hidden, '#!/bin/sh\n');
  await chmod(allowed, 0o755);
  await chmod(hidden, 0o755);

  const spec = buildShellSpawnSpec('allowed', {
    policyMode: 'off',
    backend: 'none',
    workspaceRoot: dir,
    allowCommands: ['allowed'],
    useHostPath: false,
    envPath: dir,
    shareNet: false,
  });
  assert.equal(spec.backend, 'host');
  assert.notEqual(spec.env?.PATH, dir);
  assert.deepEqual(await readdir(spec.env?.PATH ?? ''), ['allowed']);
  await Promise.all((spec.cleanupPaths ?? []).map((path) => rm(path, { recursive: true, force: true })));

  const hostSpec = buildShellSpawnSpec('allowed', {
    policyMode: 'off',
    backend: 'none',
    workspaceRoot: dir,
    allowCommands: ['allowed'],
    useHostPath: true,
    envPath: dir,
    shareNet: false,
  });
  assert.equal(hostSpec.backend, 'host');
  assert.notEqual(hostSpec.env?.PATH, dir);
  assert.deepEqual(await readdir(hostSpec.env?.PATH ?? ''), ['allowed']);
  await Promise.all((hostSpec.cleanupPaths ?? []).map((path) => rm(path, { recursive: true, force: true })));
});

test('buildBwrapArgs confines workspace and hides network by default', () => {
  const workspaceRoot = resolve('/workspace/app');
  const args = buildBwrapArgs({
    workspaceRoot,
    command: 'cat package.json',
    allowCommands: ['cat'],
    shareNet: false,
  });

  assert.ok(args.includes('--unshare-all'));
  assert.equal(args.includes('--share-net'), false);
  assert.deepEqual(args.slice(args.indexOf('--bind'), args.indexOf('--bind') + 3), ['--bind', workspaceRoot, workspaceRoot]);
  assert.deepEqual(args.slice(args.indexOf('--chdir'), args.indexOf('--chdir') + 2), ['--chdir', workspaceRoot]);
  assert.match(args[args.indexOf('--setenv') + 2] ?? '', /\/bin|\/usr\/bin/);
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'cat package.json']);
});

test('buildBwrapArgs can explicitly share network namespace', () => {
  const args = buildBwrapArgs({
    workspaceRoot: resolve('/workspace/app'),
    command: 'printf ok',
    allowCommands: [],
    shareNet: true,
  });

  assert.ok(args.includes('--share-net'));
  assert.ok(args.includes('/etc/resolv.conf'));
  assert.ok(args.includes('/etc/ssl/certs') || args.includes('/usr/share/ca-certificates'));
});

test('buildBwrapArgs mounts git templates when git is allowed', () => {
  const args = buildBwrapArgs({
    workspaceRoot: resolve('/workspace/app'),
    command: 'git init repo',
    allowCommands: ['git'],
    shareNet: false,
  });

  assert.equal(args.includes('/usr/share/git-core'), true);
});

test('describeShellSandbox reports effective shell mode', () => {
  assert.equal(
    describeShellSandbox({
      policyMode: 'off',
    backend: 'auto',
    workspaceRoot: '/workspace/app',
    allowCommands: [],
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
    allowCommands: [],
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
      allowCommands: [],
      useHostPath: true,
      shareNet: false,
    }),
    'host (visible commands)',
  );
});
