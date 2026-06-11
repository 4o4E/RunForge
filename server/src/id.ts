const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CUSTOM_EPOCH = 1_735_689_600_000n; // 2025-01-01T00:00:00.000Z
const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_WORKER_ID = (1n << WORKER_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

let lastMs = -1n;
let sequence = 0n;

function workerId(): bigint {
  const raw = process.env.SNOWFLAKE_WORKER_ID;
  if (raw != null && raw !== '') {
    const parsed = BigInt(raw);
    if (parsed < 0n || parsed > MAX_WORKER_ID) {
      throw new Error(`SNOWFLAKE_WORKER_ID must be between 0 and ${MAX_WORKER_ID}`);
    }
    return parsed;
  }
  return BigInt(process.pid) & MAX_WORKER_ID;
}

function toBase62(value: bigint): string {
  if (value === 0n) return '0';
  let n = value;
  let out = '';
  while (n > 0n) {
    const idx = Number(n % 62n);
    out = BASE62[idx] + out;
    n /= 62n;
  }
  return out;
}

function waitNextMs(current: bigint): bigint {
  let now = BigInt(Date.now());
  while (now <= current) now = BigInt(Date.now());
  return now;
}

/** 生成自定义雪花 ID，并转换为更短的 base62 字符串，供公开主键使用。 */
export function newId(): string {
  let now = BigInt(Date.now());
  if (now < lastMs) now = lastMs;

  if (now === lastMs) {
    sequence = (sequence + 1n) & MAX_SEQUENCE;
    if (sequence === 0n) now = waitNextMs(lastMs);
  } else {
    sequence = 0n;
  }

  lastMs = now;
  const timestamp = now - CUSTOM_EPOCH;
  const id = (timestamp << (WORKER_BITS + SEQUENCE_BITS)) | (workerId() << SEQUENCE_BITS) | sequence;
  return toBase62(id);
}

