import "server-only";
import { blockConfig, hubConfig } from "@/config";
import { getOverrides } from "@/server/overrides/repo";
import { lockedPriceCounts } from "@/server/overrides/model";
import { skuKey } from "@/lib/skus";
import { editableFields, fieldChanges, fieldProblem } from "@/lib/vetrina/fields";
import type {
  FieldValues,
  Homepage,
  ProductCard,
  RailDetail,
  RailFallback,
  RailHistoryState,
  RailState,
  RailWriteResult,
  VetrinaErrorCode,
} from "@/lib/vetrina/types";
import { railCategory } from "@/lib/collections/rail";
import type { RailCollection } from "@/lib/collections/types";
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

/**
 * The automatic categories, by category id: a rail showing one of them is
 * filled by its rule. Best-effort, like the locks — a Hub without the table
 * (or a database) still shows the homepage.
 */
async function automaticCategories(): Promise<Record<number, RailCollection>> {
  try {
    const { collectionsByTerm } = await import("@/server/collections/service");
    return await collectionsByTerm();
  } catch {
    return {};
  }
}

export interface VetrinaHome {
  home: Homepage;
  locks: Record<string, number>;
  /** Automatic categories by category id. */
  collections: Record<number, RailCollection>;
  source: "wordpress" | "fixture";
}

export async function readHome(): Promise<VetrinaHome> {
  const source = await getVetrinaSource();
  const home = await source.homepage();
  const shown = home.blocks.flatMap((b) => (b.kind === "rail" ? b.rail.products : []));
  const [locks, collections] = await Promise.all([locksFor(shown), automaticCategories()]);
  return { home, locks, collections, source: source.kind };
}

export interface VetrinaRail {
  rail: RailDetail;
  locks: Record<string, number>;
  /** The rule filling the rail's category, if it has one. */
  collection: RailCollection | null;
  source: "wordpress" | "fixture";
}

export async function readRail(key: string, fallback?: RailFallback): Promise<VetrinaRail> {
  const source = await getVetrinaSource();
  const rail = await source.rail(key, { count: hubConfig.vetrina.pageSize, fallback });
  const [locks, collections] = await Promise.all([locksFor([...rail.items, ...rail.hidden]), automaticCategories()]);
  const term = railCategory(rail);
  return { rail, locks, collection: term != null ? (collections[term] ?? null) : null, source: source.kind };
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
  /** The section's fields as the customer left them (only changes are written). */
  fields?: FieldValues;
  limit?: number;
}

const RAIL_BLOCK = "golden-hive/shortcode-wrapper";

/**
 * The field edits a publish may carry: the fields the config lets the
 * customer edit and the site's plugin supports, checked, and only those that
 * change. Anything else in `wanted` is ignored, never written.
 */
function allowedFieldChanges(blockName: string, configured: readonly string[], current: FieldValues, wanted: FieldValues): FieldValues {
  const editable = new Set(editableFields(blockName, configured, current));
  const requested: FieldValues = {};
  for (const [field, value] of Object.entries(wanted)) {
    if (!editable.has(field)) continue;
    const problem = fieldProblem(blockName, field, value);
    if (problem) throw new VetrinaError("invalid", `Valore non valido per ${field} (${problem}).`, 400);
    requested[field] = value;
  }
  return fieldChanges(current, { ...current, ...requested });
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
  const allowed = blockConfig(RAIL_BLOCK).edit;
  const max = hubConfig.vetrina.maxPins;
  const pin = allowed.pins ? input.pin : current.pin;
  if (pin.length > max) {
    throw new VetrinaError("invalid", `Al massimo ${max} prodotti in posizione fissa.`, 400);
  }
  const fields = allowedFieldChanges(RAIL_BLOCK, allowed.fields, current.fields, input.fields ?? {});
  // A size is only written by a plugin that reports fields (≥ 5.10.0): an
  // older one would silently ignore it.
  const sizeable = allowed.limit && Object.keys(current.fields).length > 0;
  let limit: number | undefined;
  if (sizeable && input.limit != null && input.limit !== current.limit) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > hubConfig.vetrina.maxLimit) {
      throw new VetrinaError("invalid", `Da 1 a ${hubConfig.vetrina.maxLimit} prodotti per sezione.`, 400);
    }
    limit = input.limit;
  }
  return source.writeRail({
    pageId: current.pageId,
    path: current.path,
    blockName: RAIL_BLOCK,
    expectedModifiedGmt: current.modifiedGmt,
    expectedAttrsHash: current.attrsHash,
    pin,
    exclude: allowed.exclude ? input.exclude : current.exclude,
    fallback: allowed.fallback && hubConfig.vetrina.fallbacks.includes(input.fallback) ? input.fallback : current.fallback,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(limit != null ? { limit } : {}),
  });
}

export interface PublishBlockInput {
  /** The block as the home screen read it. */
  path: string;
  blockName: string;
  expectedModifiedGmt: string;
  expectedAttrsHash: string;
  fields: FieldValues;
}

/**
 * Publish a block's fields (a slider's title, the FAQ's subtitle). The page is
 * read again: the write is refused when it changed since the home screen
 * loaded, and only fields the config allows — and that change — are sent.
 */
export async function publishBlock(input: PublishBlockInput): Promise<RailWriteResult> {
  const source = await getVetrinaSource();
  const home = await source.homepage();
  const block = home.blocks.find((b) => b.path === input.path && b.name === input.blockName);
  if (!block || block.kind !== "static" || !block.fields || !block.attrsHash) {
    throw new VetrinaError("stale", "La homepage è stata modificata nel frattempo: ricarica.", 409);
  }
  if (home.modifiedGmt !== input.expectedModifiedGmt || block.attrsHash !== input.expectedAttrsHash) {
    throw new VetrinaError("stale", "La homepage è stata modificata nel frattempo: ricarica.", 409);
  }
  const fields = allowedFieldChanges(block.name, blockConfig(block.name).edit.fields, block.fields, input.fields);
  if (Object.keys(fields).length === 0) {
    throw new VetrinaError("invalid", "Nessun campo da cambiare.", 400);
  }
  return source.writeBlock({
    pageId: home.pageId,
    path: block.path,
    blockName: block.name,
    expectedModifiedGmt: home.modifiedGmt,
    expectedAttrsHash: block.attrsHash,
    fields,
  });
}
