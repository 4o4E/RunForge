import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { api } from './http.js';
import { store } from '../store/index.js';
import { hashPassword } from '../auth/passwords.js';

// store/index.js 按 STORE 选择 MemoryStore 或 PgStore。单元测试使用 STORE=memory，
// PostgreSQL 集成测试使用真实 PgStore；路由、认证和数据库访问始终经过同一份 helper。
// 每个用例用独立的 tenant/email，避免 node:test 并发跑同文件用例时互相踩踏共享状态。
// tenants.test.ts / system.test.ts / system.postgres.test.ts 共用这份 helper。

export function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  return app;
}

export function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        }),
      });
    });
  });
}

export async function seedOwner(tenantId: string, email: string, password: string) {
  const provisioned = await store.createTenantWithOwner({
    id: tenantId,
    name: tenantId,
    ownerEmail: email,
    ownerPasswordHash: hashPassword(password),
    settingsTemplate: [],
  });
  return provisioned.owner;
}

export async function seedSystemAdmin(email: string, password: string) {
  return store.createSystemAdmin({ email, passwordHash: hashPassword(password) });
}
