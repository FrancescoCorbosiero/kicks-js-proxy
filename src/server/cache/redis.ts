import "server-only";
import Redis from "ioredis";
import { env } from "@/lib/env";
import type { Cache } from "./memory";
import { MemoryCache } from "./memory";

const globalForRedis = globalThis as unknown as { __redis?: Redis };

function getRedis(): Redis {
  if (!globalForRedis.__redis) {
    globalForRedis.__redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Avoid unhandled 'error' events crashing the process when Redis is down.
    globalForRedis.__redis.on("error", () => {});
  }
  return globalForRedis.__redis;
}

/**
 * Redis-backed cache that degrades to an in-process MemoryCache on any Redis
 * error (down, misconfigured, offline). Caching is best-effort: a cache miss or
 * outage must never break a fetch.
 */
export class RedisCache implements Cache {
  private readonly fallback = new MemoryCache();

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await getRedis().get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return this.fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await getRedis().set(key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSeconds)));
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }
}

let cacheSingleton: Cache | null = null;

export function getCache(): Cache {
  if (!cacheSingleton) cacheSingleton = new RedisCache();
  return cacheSingleton;
}
