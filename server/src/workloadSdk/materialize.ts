import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 业务插件由调用方维护，不能假设其 workspace 已执行 npm install。RunForge 把自己维护的
 * 零依赖 SDK 入口复制到 run workspace，并通过环境变量提供稳定位置。
 */
export async function materializeWorkloadSdk(workspaceRoot: string): Promise<string> {
  const source = fileURLToPath(import.meta.resolve('@runforge/workload-sdk'));
  const target = resolve(workspaceRoot, '.agents/runforge-workload-sdk/index.mjs');
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(source, staging);
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true });
  }
  return target;
}
