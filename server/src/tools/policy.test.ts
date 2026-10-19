import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createPolicy, isWithin, type ToolPolicyConfig } from './policy.js';

const ROOT = resolve('/workspace/app');

function cfg(over: Partial<ToolPolicyConfig> = {}): ToolPolicyConfig {
  return {
    sandbox: 'enforce',
    workspaceRoot: ROOT,
    shellEnabled: true,
    shellDeny: ['rm\\s+-rf\\s+/'],
    network: 'enabled',
    maxOutput: 50,
    ...over,
  };
}

test('isWithin: confinement check handles escapes and absolutes', () => {
  assert.equal(isWithin(ROOT, resolve(ROOT, 'src/a.ts')), true);
  assert.equal(isWithin(ROOT, ROOT), true);
  assert.equal(isWithin(ROOT, resolve(ROOT, '../other/x')), false);
  assert.equal(isWithin(ROOT, resolve('/etc/passwd')), false);
});

test('enforce: filesystem path confinement', () => {
  const p = createPolicy(cfg());
  assert.equal(p.check('file_read', { path: resolve(ROOT, 'src/a.ts') }).ok, true);
  const escaped = p.check('file_write', { path: resolve(ROOT, '../secret.txt') });
  assert.equal(escaped.ok, false);
  assert.match((escaped as { reason: string }).reason, /超出 workspace/);
  // Optional path (glob default cwd) is allowed through.
  assert.equal(p.check('glob', { pattern: '**/*' }).ok, true);
});

test('用户文件目录只允许访问当前用户的根目录', () => {
  const own = resolve('/u/us_owner');
  const policy = createPolicy(cfg(), own);
  assert.equal(policy.check('file_write', { path: resolve(own, 'notes.md') }).ok, true);
  assert.equal(policy.check('file_read', { path: resolve('/u/us_other/notes.md') }).ok, false);
  assert.equal(policy.check('file_read', { path: resolve(own, '../us_other/notes.md') }).ok, false);
});

test('workspace JSON 重定向和只读插件执行不会被整条命令误判', () => {
  const p = createPolicy(cfg());
  const command = `cd ${ROOT} && cat > fwd.json <<'EOF'\n{"text":"plugins/qq-bot"}\nEOF\nnode plugins/qq-bot/bot.mjs fwd.json; cat out_fwd.json`;
  for (const name of ['shell', 'shell_exec']) {
    assert.equal(p.check(name, { command }).ok, true);
    assert.equal(p.check(name, { command: 'sed -i s/old/new/ result.json; cat plugins/demo/README.md' }).ok, true);
  }
});

test('off mode skips path confinement', () => {
  const p = createPolicy(cfg({ sandbox: 'off' }));
  assert.equal(p.check('file_read', { path: resolve('/etc/passwd') }).ok, true);
});

test('enforce: shell denylist and disable', () => {
  assert.equal(createPolicy(cfg()).check('shell', { command: 'rm -rf /' }).ok, false);
  assert.equal(createPolicy(cfg()).check('shell', { command: 'ls -la' }).ok, true);
  assert.equal(createPolicy(cfg({ shellEnabled: false })).check('shell', { command: 'ls' }).ok, false);
});

test('enforce: network switch gates web tools', () => {
  assert.equal(createPolicy(cfg({ network: 'enabled' })).check('web_fetch', { url: 'https://example.com/x' }).ok, true);
  assert.equal(createPolicy(cfg({ network: 'enabled' })).check('web_search', { query: 'x' }).ok, true);
  const blocked = createPolicy(cfg({ network: 'disabled' })).check('web_fetch', { url: 'https://example.com/x' });
  assert.equal(blocked.ok, false);
  assert.match((blocked as { reason: string }).reason, /网络访问已禁用/);
});

test('capOutput truncates oversized results', () => {
  const p = createPolicy(cfg({ maxOutput: 50 }));
  assert.equal(p.capOutput('short'), 'short');
  const out = p.capOutput('x'.repeat(90));
  assert.match(out, /已截断 40 个字符/);
  assert.ok(out.length <= 50);
});

test('capOutput removes NUL characters before persistence', () => {
  const p = createPolicy(cfg({ maxOutput: 50 }));
  assert.equal(p.capOutput('a\u0000b'), 'ab');
});
