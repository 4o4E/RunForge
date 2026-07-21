import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { api } from './http.js';
import { store } from '../store/index.js';
import { hashPassword } from '../auth/passwords.js';

// STORE=memory(见 package.json test 脚本)让 ./http.js 里的路由触达的单例 store
// 解析成 MemoryStore，不依赖真实 Postgres。每个用例用独立的 tenant/email，避免
// node:test 并发跑同文件顶层用例时互相踩踏共享的 store 状态。
// tenants.test.ts / system.test.ts 共用这份 helper，避免三份文件各自复制一份。

export function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  return app;
}

export function listen(app: express.Express): Promise<{ port: number; close: () => void }> {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

export async function seedOwner(tenantId: string, email: string, password: string) {
  await store.createTenant({ id: tenantId, name: tenantId });
  return store.createUser({ tenantId, email, passwordHash: hashPassword(password), role: 'owner' });
}

export async function seedSystemAdmin(email: string, password: string) {
  return store.createSystemAdmin({ email, passwordHash: hashPassword(password) });
}
