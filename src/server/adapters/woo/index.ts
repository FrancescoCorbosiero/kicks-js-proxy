import "server-only";
import type { AppConfig } from "@core/config";
import type { WooStoreAdapter } from "@core/core-spine";
import { env } from "@/lib/env";
import { createWooStore } from "./client";

/** Build the WooCommerce StorePort from the active config + env secrets. */
export function getStore(config: AppConfig): WooStoreAdapter {
  return createWooStore({
    baseUrl: env.WOO_BASE_URL,
    consumerKey: env.WOO_CONSUMER_KEY,
    consumerSecret: env.WOO_CONSUMER_SECRET,
    matching: config.matching,
    retry: {
      attempts: config.apply.retry.attempts,
      backoffMs: config.apply.retry.backoffMs,
      timeoutMs: 20_000,
    },
  });
}
