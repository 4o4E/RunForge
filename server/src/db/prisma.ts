import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { pool } from './pool.js';

// 迁移期间 Prisma 与尚未迁完的原生查询共用连接池，避免一次请求维护两套数据库连接。
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
