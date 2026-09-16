import { prisma } from '../db/prisma.js';
import { requiredJson } from './prismaRows.js';

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface SettingEntry {
  key: string;
  value: unknown;
}

export async function findSettings(tenantId: string, keys: readonly string[]): Promise<SettingRecord[]> {
  return prisma.app_settings.findMany({
    where: { tenant_id: tenantId, key: { in: [...keys] } },
    select: { key: true, value: true },
  });
}

export async function findSetting(tenantId: string, key: string): Promise<unknown> {
  const row = await prisma.app_settings.findUnique({
    where: { tenant_id_key: { tenant_id: tenantId, key } },
    select: { value: true },
  });
  return row?.value;
}

export async function insertMissingSettings(tenantId: string, entries: readonly SettingEntry[]): Promise<void> {
  if (!entries.length) return;
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
