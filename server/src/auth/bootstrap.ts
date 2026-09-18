import { config } from '../config.js';
import { store as defaultStore } from '../store/index.js';
import type { Store } from '../store/types.js';
import { tenantSettingsTemplateEntries } from '../settings.js';
import { hashPassword } from './passwords.js';
import { hashOpaqueToken } from './tokens.js';
import { newTenantId } from '../id.js';
import { setSystemResourceTenantId } from '../systemResourceTenant.js';
import { migrateLegacyBootstrapWorkspace } from '../files/workspaceRoot.js';

const LEGACY_BOOTSTRAP_TENANT_ID = 'default';
const DEFAULT_ADMIN_EMAIL = 'admin@local';
const DEFAULT_SYSADMIN_EMAIL = 'sysadmin@local';
// 固定默认密码，而不是随机生成：自托管部署图的是"装完就有一个能登录的已知账号"，
// 记不住随机打印在日志里的一次性密码。生产/公网环境应通过
// RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD / RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD 覆盖，
// 或登录后立刻改密。
const DEFAULT_BOOTSTRAP_PASSWORD = '1234.RunForge.5678';

export interface BootstrapReport {
  tenantId: string;
  tenantCreated: boolean;
  tenantIdMigrated: boolean;
  ownerCreated: boolean;
  ownerSource: 'migrated-access-token' | 'default-password' | null;
  systemAdminCreated: boolean;
}

export interface BootstrapOptions {
  /** 默认读 config.auth.accessToken；测试传显式值，避免依赖可变全局状态。 */
  legacyAccessToken?: string;
  adminPassword?: string;
  sysadminPassword?: string;
  migrateWorkspace?: boolean;
}

/** 幂等的启动期引导(docs/multi-tenancy-design.md §4):确保 bootstrap tenant、
 *  至少一个 active owner、至少一个 active system admin 存在。迁移场景复用
 *  RUNFORGE_ACCESS_TOKEN 注册成 owner 的 API token；登录密码统一走固定默认值
 *  (可通过 RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD / RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD 覆盖)。 */
export async function runBootstrap(storeArg: Store = defaultStore, options: BootstrapOptions = {}): Promise<BootstrapReport> {
  const report: BootstrapReport = {
    tenantId: '',
    tenantCreated: false,
    tenantIdMigrated: false,
    ownerCreated: false,
    ownerSource: null,
    systemAdminCreated: false,
  };
  const adminPasswordOverride = (options.adminPassword ?? config.auth.bootstrapAdminPassword).trim();
  const sysadminPasswordOverride = (options.sysadminPassword ?? config.auth.bootstrapSysadminPassword).trim();

  let tenant = await storeArg.findBootstrapTenant();
  if (!tenant) {
    const legacyTenant = await storeArg.findTenant(LEGACY_BOOTSTRAP_TENANT_ID);
    if (legacyTenant) {
      tenant = await storeArg.migrateBootstrapTenantId(legacyTenant.id, newTenantId());
      report.tenantIdMigrated = true;
      console.log(`[bootstrap] 已将旧 bootstrap tenant ID 迁移为 ${tenant.id}`);
    }
  }
  if (!tenant) {
    const legacyToken = (options.legacyAccessToken ?? config.auth.accessToken).trim();
    const loginPassword = adminPasswordOverride || DEFAULT_BOOTSTRAP_PASSWORD;
    const provisioned = await storeArg.createTenantWithOwner({
      id: newTenantId(),
      name: 'Default',
      isBootstrap: true,
      ownerEmail: DEFAULT_ADMIN_EMAIL,
      ownerPasswordHash: hashPassword(loginPassword),
      settingsTemplate: tenantSettingsTemplateEntries({ bootstrap: true }),
    });
    tenant = provisioned.tenant;
    report.tenantCreated = true;
    if (legacyToken) {
      await storeArg.createAuthToken({
        tenantId: tenant.id,
        userId: provisioned.owner.id,
        kind: 'api',
        tokenHash: hashOpaqueToken(legacyToken),
        label: 'migrated RUNFORGE_ACCESS_TOKEN',
      });
      report.ownerCreated = true;
      report.ownerSource = 'migrated-access-token';
      console.log(`[bootstrap] 已将现有 RUNFORGE_ACCESS_TOKEN 注册为 owner 账号 ${DEFAULT_ADMIN_EMAIL} 的 API token`);
      console.log(`[bootstrap] ${DEFAULT_ADMIN_EMAIL} 的登录密码: ${loginPassword}`);
    } else {
      report.ownerCreated = true;
      report.ownerSource = 'default-password';
      console.log(`[bootstrap] 已创建 owner 账号 ${DEFAULT_ADMIN_EMAIL}，登录密码: ${loginPassword}`);
    }
  } else {
    const existingUsers = await storeArg.listUsersByTenant(tenant.id);
    const hasActiveOwner = existingUsers.some((u) => u.role === 'owner' && u.status === 'active');
    if (!hasActiveOwner) {
      const password = adminPasswordOverride || DEFAULT_BOOTSTRAP_PASSWORD;
      await storeArg.createUser({
        tenantId: tenant.id,
        email: DEFAULT_ADMIN_EMAIL,
        passwordHash: hashPassword(password),
        role: 'owner',
      });
      report.ownerCreated = true;
      report.ownerSource = 'default-password';
      console.log(`[bootstrap] 已创建 owner 账号 ${DEFAULT_ADMIN_EMAIL}，登录密码: ${password}`);
    }
  }

  if (options.migrateWorkspace ?? (storeArg === defaultStore && process.env.STORE !== 'memory')) {
    await migrateLegacyBootstrapWorkspace(tenant.id);
  }
  report.tenantId = tenant.id;
  if (storeArg === defaultStore) setSystemResourceTenantId(tenant.id);

  const existingSystemAdmins = await storeArg.listSystemAdmins();
  const hasActiveSystemAdmin = existingSystemAdmins.some((a) => a.status === 'active');
  if (!hasActiveSystemAdmin) {
    const password = sysadminPasswordOverride || DEFAULT_BOOTSTRAP_PASSWORD;
    await storeArg.createSystemAdmin({ email: DEFAULT_SYSADMIN_EMAIL, passwordHash: hashPassword(password) });
    report.systemAdminCreated = true;
    console.log(`[bootstrap] 已创建系统管理员账号 ${DEFAULT_SYSADMIN_EMAIL}，登录密码: ${password}`);
  }

  return report;
}
