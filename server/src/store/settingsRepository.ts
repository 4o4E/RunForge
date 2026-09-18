import { prisma } from '../db/prisma.js';
import { requiredJson } from './prismaRows.js';
import { Prisma } from '../generated/prisma/client.js';

const useMemory = process.env.STORE === 'memory';
const memorySettings = new Map<string, Map<string, unknown>>();

function memoryTenantSettings(tenantId: string): Map<string, unknown> {
  const existing = memorySettings.get(tenantId);
  if (existing) return existing;
  const created = new Map<string, unknown>();
  memorySettings.set(tenantId, created);
  return created;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface SettingEntry {
  key: string;
  value: unknown;
}

export async function findSettings(tenantId: string, keys: readonly string[]): Promise<SettingRecord[]> {
  if (useMemory) {
    const settings = memoryTenantSettings(tenantId);
    return keys.flatMap((key) => settings.has(key) ? [{ key, value: structuredClone(settings.get(key)) }] : []);
  }
  return prisma.app_settings.findMany({
    where: { tenant_id: tenantId, key: { in: [...keys] } },
    select: { key: true, value: true },
  });
}

export async function findSetting(tenantId: string, key: string): Promise<unknown> {
  if (useMemory) {
    const settings = memoryTenantSettings(tenantId);
    return settings.has(key) ? structuredClone(settings.get(key)) : undefined;
  }
  const row = await prisma.app_settings.findUnique({
    where: { tenant_id_key: { tenant_id: tenantId, key } },
    select: { value: true },
  });
  return row?.value;
}

export async function insertMissingSettings(tenantId: string, entries: readonly SettingEntry[]): Promise<void> {
  if (!entries.length) return;
  if (useMemory) {
    const settings = memoryTenantSettings(tenantId);
    for (const entry of entries) {
      if (!settings.has(entry.key)) settings.set(entry.key, structuredClone(entry.value));
    }
    return;
  }
  await prisma.app_settings.createMany({
    data: entries.map((entry) => ({
      tenant_id: tenantId,
      key: entry.key,
      value: requiredJson(entry.value),
    })),
    skipDuplicates: true,
  });
}

export async function upsertSettings(tenantId: string, entries: readonly SettingEntry[]): Promise<void> {
  if (!entries.length) return;
  if (useMemory) {
    const settings = memoryTenantSettings(tenantId);
    for (const entry of entries) settings.set(entry.key, structuredClone(entry.value));
    return;
  }
  const updatedAt = new Date();
  await prisma.$transaction(entries.map((entry) => {
    const value = requiredJson(entry.value);
    return prisma.app_settings.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key: entry.key } },
      create: { tenant_id: tenantId, key: entry.key, value, updated_at: updatedAt },
      update: { value, updated_at: updatedAt },
    });
  }));
}

function isRetryableSettingConflict(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
  return code === 'P2034' || code === 'P2002';
}

/**
 * tenant 配置是整块 JSON；读、合并、写必须处于同一串行化事务，避免两个管理员分别修改
 * 不同插件时后提交的人覆盖先提交的内容。数据库检测到竞争后在这里重试整个合并过程。
 */
export async function updateSettingAtomically<T>(
  tenantId: string,
  key: string,
  update: (current: unknown) => T,
): Promise<T> {
  if (useMemory) {
    const settings = memoryTenantSettings(tenantId);
    const next = update(settings.has(key) ? structuredClone(settings.get(key)) : undefined);
    settings.set(key, structuredClone(next));
    return next;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const current = await tx.app_settings.findUnique({
          where: { tenant_id_key: { tenant_id: tenantId, key } },
          select: { value: true },
        });
        const next = update(current?.value);
        await tx.app_settings.upsert({
          where: { tenant_id_key: { tenant_id: tenantId, key } },
          create: { tenant_id: tenantId, key, value: requiredJson(next) },
          update: { value: requiredJson(next), updated_at: new Date() },
        });
        return next;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt === 2 || !isRetryableSettingConflict(error)) throw error;
    }
  }
  throw new Error('tenant 配置并发更新重试耗尽');
}
