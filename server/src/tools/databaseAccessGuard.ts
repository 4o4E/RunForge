const DATABASE_CLI_RE = /(^|[\s;&|()])(?:psql|mysql|mongosh|beeline|duckdb|sqlite3)\b|\$DATABASE_URL|\$\{DATABASE_URL[}:+-]?/;
const DATABASE_ACCESS_SCRIPT_RE = /(?:^|[\s"';&|()])(?:[^\s"';&|()]*\/)?(?:\.agents\/skills\/database-access|server\/src\/skills\/builtin\/database-access)\/scripts\/(?:psql-query\.mjs|datasource-list\.mjs|dbCredential\.mjs)\b/;

/** 判断 shell 命令是否会访问数据库凭证或平台数据库 SDK。 */
export function requiresDatabaseAccess(command: string): boolean {
  return usesDatabaseCli(command) || usesDatabaseAccessHelper(command);
}

/** 判断命令是否直接调用数据库 CLI 或宿主 DATABASE_URL。 */
export function usesDatabaseCli(command: string): boolean {
  return DATABASE_CLI_RE.test(command);
}

/** 判断命令是否通过本 run 的 database-access helper 换取短期凭证。 */
export function usesDatabaseAccessHelper(command: string): boolean {
  return DATABASE_ACCESS_SCRIPT_RE.test(command);
}
