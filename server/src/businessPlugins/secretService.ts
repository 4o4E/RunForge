import { prisma } from '../db/prisma.js';
import { newWorkloadSecretAccessId } from '../id.js';
import { normalizeBusinessPluginTenantSettings } from './settings.js';
import { validateWorkloadToken } from '../datasources/accountPool.js';
import { store } from '../store/index.js';

const BUSINESS_PLUGIN_SETTINGS_KEY = 'businessPlugins.settings';

export type BusinessSecretAccessor = 'backend' | 'workload';

interface WorkloadSecretAccessContext {
  tenantId: string;
  runId: string;
  stepId?: string | null;
  tokenId: string;
  accessor: BusinessSecretAccessor;
}

async function contextForToken(
  rawToken: string,
  accessor: BusinessSecretAccessor,
  requestedStepId?: string | null,
): Promise<WorkloadSecretAccessContext> {
  const validated = await validateWorkloadToken(rawToken);
  const run = await store.getRunUnscoped(validated.token.run_id);
  if (!run) throw new Error('WORKLOAD_TOKEN 对应的 run 不存在');
  const thread = await store.getThreadUnscoped(run.thread_id);
  if (!thread) throw new Error('WORKLOAD_TOKEN 对应的 thread 不存在');
  const stepId = requestedStepId?.trim()
    ? (await prisma.steps.findFirst({
      where: { id: requestedStepId.trim(), run_id: run.id },
      select: { id: true },
    }))?.id ?? null
    : null;
  return {
    tenantId: thread.tenant_id,
    runId: run.id,
    stepId,
    tokenId: validated.token.id,
    accessor,
  };
}

function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

function auditRows(
  context: WorkloadSecretAccessContext,
  keys: readonly string[],
  result: (key: string) => { status: 'success' | 'denied' | 'error'; errorCode?: string },
) {
  return keys.map((key) => {
    const state = result(key);
    return {
      id: newWorkloadSecretAccessId(),
      tenant_id: context.tenantId,
      run_id: context.runId,
      step_id: context.stepId ?? null,
      token_id: context.tokenId,
      accessor: context.accessor,
      secret_key: key,
      status: state.status,
      error_code: state.errorCode ?? null,
    };
  });
}

/**
 * Secret 当前值读取和成功/缺失审计在同一事务提交。只有审计已经可靠落库后，调用方才会
 * 收到明文；返回对象只存在于当前调用栈，不写入 run 配置、事件或普通日志。
 */
export async function readAuditedWorkloadSecrets(
  rawToken: string,
  accessor: BusinessSecretAccessor,
  stepId: string | null | undefined,
  requestedKeys: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const keys = uniqueKeys(requestedKeys);
  if (!keys.length) return {};
  const context = await contextForToken(rawToken, accessor, stepId);
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.app_settings.findUnique({
        where: {
          tenant_id_key: {
            tenant_id: context.tenantId,
            key: BUSINESS_PLUGIN_SETTINGS_KEY,
          },
        },
        select: { value: true },
      });
      const settings = normalizeBusinessPluginTenantSettings(row?.value);
      const values: Record<string, string> = {};
      for (const key of keys) {
        const value = Object.hasOwn(settings.secrets, key) ? settings.secrets[key] : undefined;
        if (value?.trim()) values[key] = value;
      }
      await tx.workload_secret_access_logs.createMany({
        data: auditRows(context, keys, (key) => (
          Object.hasOwn(values, key)
            ? { status: 'success' }
            : { status: 'error', errorCode: 'BUSINESS_PLUGIN_SECRET_UNAVAILABLE' }
        )),
      });
      return values;
    });
  } catch (error) {
    // 配置解析失败时上面的事务已经回滚；尽力补一条不含值的错误审计。审计本身失败时
    // 直接保留原异常，且绝不返回 Secret。
    await prisma.workload_secret_access_logs.createMany({
      data: auditRows(context, keys, () => ({
        status: 'error',
        errorCode: 'BUSINESS_PLUGIN_SECRET_READ_FAILED',
      })),
    }).catch(() => {});
    throw error;
  }
}
