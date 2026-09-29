import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BUNDLED_SCRIPTS = new Map([
  ['google-lens', {
    language: 'ts',
    path: fileURLToPath(new URL('../assets/scripts/google-lens.ts', import.meta.url)),
  }],
]);

/** 只在服务端缺失时恢复插件受控的 Brix 脚本，已存在脚本不会被覆盖。 */
export async function ensureBundledScript(client, name) {
  const bundled = BUNDLED_SCRIPTS.get(name);
  if (!bundled) return false;
  const source = await readFile(bundled.path, 'utf8');
  await client.ensureScript(name, source, bundled.language);
  return true;
}

export function bundledScriptNames() {
  return [...BUNDLED_SCRIPTS.keys()];
}
