import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Prisma CLI 从 server/ 启动，显式读取仓库根目录配置，保持与服务端运行时一致。
dotenv.config({ path: resolve(import.meta.dirname, '../.env') });
dotenv.config({ path: resolve(import.meta.dirname, '.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
