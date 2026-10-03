import { pool } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { runBootstrap } from '../auth/bootstrap.js';
import { store } from '../store/index.js';

try {
  await runBootstrap(store, {
    legacyAccessToken: '',
    adminPassword: 'runforge-ci-only-admin-password',
    sysadminPassword: 'runforge-ci-only-sysadmin-password',
    migrateWorkspace: false,
  });
  console.log('PostgreSQL CI 启动引导已完成。');
} finally {
  await prisma.$disconnect();
  await pool.end();
}
