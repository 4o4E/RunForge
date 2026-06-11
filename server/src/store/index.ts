import { PgStore } from './pgStore.js';
import { MemoryStore } from './memoryStore.js';
import type { Store } from './types.js';

// STORE=memory runs entirely in-process (no PostgreSQL) — handy for offline demos.
const useMemory = process.env.STORE === 'memory';

export const store: Store = useMemory ? new MemoryStore() : new PgStore();

export type { Store } from './types.js';
export * from './types.js';
