function required(value, name) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`missing required environment variable: ${name}`);
}

async function workloadClient() {
  const sdkPath = required(process.env.RUNFORGE_WORKLOAD_SDK, 'RUNFORGE_WORKLOAD_SDK');
  const { RunForgeWorkloadClient } = await import(sdkPath);
  return new RunForgeWorkloadClient();
}

/** 列出当前 run 获准访问且存在只读权限档位的数据源。 */
export async function listDatasourceResources() {
  return (await workloadClient()).resources.list('database.readonly');
}

/** 通过统一 Workload SDK 申请本次 run 的短期只读数据库凭证。 */
export async function getDatasourceCredential(options = {}) {
  return (await workloadClient()).resources.acquire('database.readonly', options);
}

export const acquireDatasourceCredential = getDatasourceCredential;
