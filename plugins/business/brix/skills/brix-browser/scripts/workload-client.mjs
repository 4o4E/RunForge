import { BrixClient } from './brix-client.mjs';

/** 使用当前 RunForge run 的租户 Secret 创建 Brix 客户端。 */
export async function createWorkloadBrixClient() {
  const { RunForgeWorkloadClient } = await import(process.env.RUNFORGE_WORKLOAD_SDK);
  const workload = new RunForgeWorkloadClient();
  const baseUrl = await workload.secrets.get('brix.base-url');
  const token = await workload.secrets.get('brix.token');
  return new BrixClient(baseUrl, token);
}
