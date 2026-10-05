import "server-only";
import { hubConfig } from "@/config";
import { env } from "@/lib/env";
import { getWooClient, wooConfigured, type WooClient } from "@/server/woo/client";
import { withTaxonomyCache } from "@/server/woo/taxonomy-cache";

/**
 * Which store the automatic categories work on: the WooCommerce shop, or —
 * while the Vetrina runs on its demo shop (VETRINA_SOURCE=fixture) — that demo
 * shop, so the homepage the Vetrina shows is the one the rules move.
 */

export function demoMode(): boolean {
  return (env.VETRINA_SOURCE ?? hubConfig.vetrina.source) === "fixture";
}

/** True when there is a store to work on. */
export function storeReady(): boolean {
  return demoMode() || wooConfigured();
}

export async function storeClient(): Promise<WooClient> {
  if (demoMode()) {
    const { fixtureClient } = await import("./fixture-client");
    return fixtureClient();
  }
  // Term listings remembered a few minutes, shared with the Publisher.
  return withTaxonomyCache(getWooClient());
}
