import "server-only";
import { blockConfig, hubConfig } from "@/config";
import { getOverrides } from "@/server/overrides/repo";
import { lockedPriceCounts } from "@/server/overrides/model";
import { skuKey } from "@/lib/skus";
import type {
  Homepage,
  ProductCard,
  RailDetail,
  RailFallback,
  RailHistoryState,
  RailState,
  RailWriteResult,
  VetrinaErrorCode,
} from "@/lib/vetrina/types";
import { getVetrinaSource, VetrinaError } from "./source";

/**
 * The Vetrina's server half: read the homepage and its rails from the
 * configured source, join the Hub's own data (price locks, by SKU), and
 * publish a rail's new order — never more than the code config allows.
 */

export type VetrinaResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: VetrinaErrorCode; error: string };

export async function attempt<T>(fn: () => Promise<T>): Promise<VetrinaResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof VetrinaError) return { ok: false, code: e.code, error: e.message };
    return { ok: false, code: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Locked sizes per SKU, only for the SKUs shown — the 🔒 on a card. */
async function locksFor(cards: ProductCard[]): Promise<Record<string, number>> {
  const overrides = await getOverrides().catch(() => null);
  if (!overrides) return {};
  const counts = lockedPriceCounts(overrides);
  const out: Record<string, number> = {};
  for (const c of cards) {
    if (!c.sku) continue;
    const n = counts.get(skuKey(c.sku));
    if (n) out[skuKey(c.sku)] = n;
  }
  return out;
}

export interface VetrinaHome {
  home: Homepage;
  locks: Record<string, number>;
  source: "wordpress" | "fixture";
}

export async function readHome(): Promise<VetrinaHome> {
  const source = await getVetrinaSource();
  const home = await source.homepage();
  const shown = home.blocks.flatMap((b) => (b.kind === "rail" ? b.rail.products : []));
  return { home, locks: await locksFor(shown), source: source.kind };
}

export interface VetrinaRail {
  rail: RailDetail;
  locks: Record<string, number>;
  source: "wordpress" | "fixture";
}

export async function readRail(key: string, fallback?: RailFallback): Promise<VetrinaRail> {
  const source = await getVetrinaSource();
  const rail = await source.rail(key, { count: hubConfig.vetrina.pageSize, fallback });
  return { rail, locks: await locksFor([...rail.items, ...rail.hidden]), source: source.kind };
}

export async function readCards(ids: number[]): Promise<{ cards: ProductCard[]; locks: Record<string, number> }> {
  const source = await getVetrinaSource();
  const cards = await source.products(ids);
  return { cards, locks: await locksFor(cards) };
}

export async function readHistory(key: string): Promise<RailHistoryState[]> {
  return (await getVetrinaSource()).history(key);
}

export interface PublishInput extends RailState {
  key: string;
  /** What the editor read — a publish on top of anything newer is refused. */
  expectedModifiedGmt: string;
  expectedAttrsHash: string;
}

/**
 * Publish a rail's order. The rail is read again first: the write goes to the
 * block as it is NOW (its path may have moved), it is refused when someone
 * changed the page since the editor loaded it, and every field the code
 * config does not let the customer edit keeps its current value.
 */
export async function publishRail(input: PublishInput): Promise<RailWriteResult> {
  const source = await getVetrinaSource();
  const current = await source.rail(input.key, { count: 1 });
  if (current.modifiedGmt !== input.expectedModifiedGmt || current.attrsHash !== input.expectedAttrsHash) {
    throw new VetrinaError("stale", "La homepage è stata modificata nel frattempo: ricarica la sezione.", 409);
  }
  const allowed = blockConfig("golden-hive/shortcode-wrapper").edit;
  const max = hubConfig.vetrina.maxPins;
  const pin = allowed.pins ? input.pin : current.pin;
  if (pin.length > max) {
    throw new VetrinaError("invalid", `Al massimo ${max} prodotti in posizione fissa.`, 400);
  }
  return source.writeRail({
    pageId: current.pageId,
    path: current.path,
    blockName: "golden-hive/shortcode-wrapper",
    expectedModifiedGmt: current.modifiedGmt,
    expectedAttrsHash: current.attrsHash,
    pin,
    exclude: allowed.exclude ? input.exclude : current.exclude,
    fallback: allowed.fallback && hubConfig.vetrina.fallbacks.includes(input.fallback) ? input.fallback : current.fallback,
  });
}
