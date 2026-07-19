import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolUsername, toPublicCredential } from './accountPool.js';
import { generateWorkloadToken, hashWorkloadToken } from './token.js';
import type { CredentialLease } from './types.js';

test('workload token 明文只用于一次性返回，服务端可用 hash 校验', () => {
  const token = generateWorkloadToken();

  assert.match(token, /^wat_[0-9A-Za-z_-]+$/);
  assert.equal(hashWorkloadToken(token), hashWorkloadToken(token));
  assert.notEqual(hashWorkloadToken(token), token);
});

test('账号池用户名只包含数据库安全字符并限制长度', () => {
  const username = buildPoolUsername('Read Only / 财务数据', 'da_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  assert.match(username, /^ag_[a-z0-9_]+$/);
  assert.ok(username.length <= 63);
});

test('返回给容器的凭证不会包含管理连接配置', () => {
  const lease: CredentialLease = {
    password: 'temporary',
    expiresAt: '2026-06-12T12:30:00.000Z',
    datasource: {
      id: 'ds_1',
      tenant_id: 'default',
      name: 'sales',
      type: 'postgres',
      status: 'active',
      enabled: true,
      connection: { host: 'db.example.com', port: 5432, database: 'sales' },
      admin_config: { connectionUrl: 'postgres://admin:secret@db.example.com/sales' },
      pool_config: {},
      created_at: '',
      updated_at: '',
    },
    profile: {
      id: 'dp_1',
      datasource_id: 'ds_1',
      name: 'readonly',
      mode: 'readonly',
      template_role: 'sales_readonly',
      grants: {},
      pool_config: {},
      created_at: '',
      updated_at: '',
    },
    account: {
      id: 'da_1',
      datasource_id: 'ds_1',
      profile_id: 'dp_1',
      username: 'ag_readonly_1',
      status: 'leased',
      current_run_id: 'ru_1',
      leased_until: null,
      last_lease_at: null,
      last_rotated_at: null,
      failure_count: 0,
      metadata: {},
      created_at: '',
      updated_at: '',
    },
    lease: {
      id: 'dl_1',
      account_id: 'da_1',
      datasource_id: 'ds_1',
      profile_id: 'dp_1',
      run_id: 'ru_1',
      token_id: 'wt_1',
      status: 'leased',
      leased_at: '',
      expires_at: '2026-06-12T12:30:00.000Z',
      released_at: null,
      error: null,
      created_at: '',
      updated_at: '',
    },
  };

  const response = toPublicCredential(lease);

  assert.equal(response.username, 'ag_readonly_1');
  assert.equal(response.password, 'temporary');
  assert.deepEqual(response.connection, { host: 'db.example.com', port: 5432, database: 'sales' });
  assert.equal('admin_config' in response, false);
});
