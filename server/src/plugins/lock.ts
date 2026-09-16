import { createHash } from 'node:crypto';
import { PluginRuntimeError } from './errors.js';
import type { JsonValue, SpaceRuntimeConfig, SpaceRuntimeLock } from './types.js';

function normalizeJson(value: unknown, path = '$', seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PluginRuntimeError('CONFIG_INVALID', `${path} 包含非有限数字，不能写入运行配置副本`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PluginRuntimeError('CONFIG_INVALID', `${path} 包含循环引用`);
    seen.add(value);
    const result = value.map((item, index) => normalizeJson(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PluginRuntimeError('CONFIG_INVALID', `${path} 必须是普通 JSON 对象`);
    }
    if (seen.has(value)) throw new PluginRuntimeError('CONFIG_INVALID', `${path} 包含循环引用`);
    seen.add(value);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new PluginRuntimeError('CONFIG_INVALID', `${path}.${key} 不是可持久化的 JSON 值`);
      }
      result[key] = normalizeJson(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new PluginRuntimeError('CONFIG_INVALID', `${path} 不是可持久化的 JSON 值`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function hashConfig(config: SpaceRuntimeConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export function createSpaceRuntimeLock(input: SpaceRuntimeConfig): SpaceRuntimeLock {
  if (!input.tenantId.trim()) throw new PluginRuntimeError('CONFIG_INVALID', 'tenantId 不能为空');
  if (!input.spaceId.trim()) throw new PluginRuntimeError('CONFIG_INVALID', 'spaceId 不能为空');
  if (!Number.isSafeInteger(input.configVersion) || input.configVersion < 1) {
    throw new PluginRuntimeError('CONFIG_INVALID', 'configVersion 必须是大于 0 的安全整数');
  }

  const plugins = input.plugins
    .map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      contentHash: plugin.contentHash,
      config: normalizeJson(plugin.config),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const normalized: SpaceRuntimeConfig = {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    configVersion: input.configVersion,
    plugins,
  };
  return deepFreeze({ ...normalized, hash: hashConfig(normalized) });
}

export function verifySpaceRuntimeLock(input: SpaceRuntimeLock): SpaceRuntimeLock {
  const normalized = createSpaceRuntimeLock(input);
  if (normalized.hash !== input.hash) {
    throw new PluginRuntimeError(
      'LOCK_HASH_MISMATCH',
      `空间 ${input.spaceId} 配置版本 ${input.configVersion} 的运行锁 hash 不匹配`,
    );
  }
  return normalized;
}
