"use server";

import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";

export interface KicksPingResult {
  ok: boolean;
  message: string;
  sampleProducts?: number;
}

/**
 * Validate KicksDB connectivity/credentials with a tiny products query. Surfaces
 * a clear message (e.g. 401 invalid key) without touching the store.
 */
export async function pingKicksDb(): Promise<KicksPingResult> {
  try {
    const config = await getActiveConfig();
    const source = getSource(config);
    const products = await source.getProduct("nike", config.source.market, 1);
    return {
      ok: true,
      message: `Connected — sample query returned ${products.length} product(s).`,
      sampleProducts: products.length,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
