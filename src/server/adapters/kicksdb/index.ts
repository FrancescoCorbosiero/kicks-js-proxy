import "server-only";
import type { AppConfig } from "@core/config";
import { env } from "@/lib/env";
import { KicksDbSource } from "./client";

/** Build the KicksDB source from the active config + env secret. */
export function getSource(config: AppConfig): KicksDbSource {
  return new KicksDbSource({
    baseUrl: env.KICKS_BASE_URL,
    apiKey: env.KICKS_SECRET,
    batchChunkSize: config.source.batchChunkSize,
    query: config.source.query,
    retry: { attempts: config.apply.retry.attempts, backoffMs: config.apply.retry.backoffMs, timeoutMs: 20_000 },
  });
}

export { KicksDbSource };
