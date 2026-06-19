/**
 * Process-local TTL cache. Used as the fallback when Redis is unreachable, and
 * directly in unit tests (the clock is injectable so TTL is deterministic).
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number; // epoch ms
}

export class MemoryCache implements Cache {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
}

/** Read-through helper: return cached value, else compute, cache, and return. */
export async function getOrSet<T>(
  cache: Cache,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const cached = await cache.get<T>(key);
  if (cached !== null) return { value: cached, hit: true };
  const value = await compute();
  await cache.set(key, value, ttlSeconds);
  return { value, hit: false };
}
