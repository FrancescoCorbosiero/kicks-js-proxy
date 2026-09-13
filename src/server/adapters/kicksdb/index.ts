import "server-only";
import type { AppConfig } from "@core/config";
import { env } from "@/lib/env";
import { KicksDbSource } from "./client";

/**
 * Is KicksDB usable at all? A GoldenSneakers-only shop runs without a KicksDB
 * account: every path that would query it must check this first and fall back
 * to the sources it does have, rather than firing doomed requests.
 */
export function kicksdbConfigured(): boolean {
  return !!env.KICKS_SECRET;
}

/** Build the KicksDB source from the active config + env secret. */
export function getSource(config: AppConfig): KicksDbSource {
  return new KicksDbSource({
    baseUrl: env.KICKS_BASE_URL,
    apiKey: env.KICKS_SECRET ?? "",
    batchChunkSize: config.source.batchChunkSize,
    query: config.source.query,
    retry: { attempts: config.apply.retry.attempts, backoffMs: config.apply.retry.backoffMs, timeoutMs: 20_000 },
  });
}

export { KicksDbSource };
