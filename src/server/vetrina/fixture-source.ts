import "server-only";
import { createHash } from "node:crypto";
import { orderIds } from "@/lib/vetrina/order";
import { FIELD_SPECS, fieldProblem } from "@/lib/vetrina/fields";
import type {
  BlockWrite,
  FieldValues,
  HiddenItem,
  Homepage,
  ProductCard,
  RailDetail,
  RailFallback,
  RailHistoryState,
  RailState,
  RailSummary,
  RailWrite,
  RailWriteResult,
} from "@/lib/vetrina/types";
import {
  DEMO_BLOCKS,
  DEMO_BRAND_PARENT,
  DEMO_TERM_IDS,
  DEMO_TERM_NAMES,
  demoProducts,
  type DemoBlock,
  type DemoProduct,
} from "./fixture-data";
import { VetrinaError, type VetrinaSource } from "./source";

/**
 * The demo shop (VETRINA_SOURCE=fixture): the same contract and the same rules
 * as golden-hive-blocks' wc-gh/v1 — membership with sub-brands, sold-out
 * products hidden, pins/exclusions/fallback, stale-write refusal, history —
 * held in memory. Nothing is written anywhere; a restart resets it.
 */

type RailBlock = Extract<DemoBlock, { kind: "rail" }>;

export interface DemoState {
  products: DemoProduct[];
  byId: Map<number, DemoProduct>;
  rails: Map<string, RailState>;
  /** Field edits by block path, over the block's own values. */
  fields: Map<string, FieldValues>;
  /** Rail sizes by rail key, over the shortcode's limit. */
  limits: Map<string, number>;
  modified: number;
  history: Map<string, (RailState & { at: number })[]>;
}

// Shared across hot reloads and server bundles, like the scheduler's state.
const g = globalThis as { __vetrinaDemo?: DemoState };

/** The demo shop itself — the automatic categories act on it in demo mode. */
export function demoShop(): DemoState {
  return state();
}

function state(): DemoState {
  if (!g.__vetrinaDemo) {
    const products = demoProducts();
    g.__vetrinaDemo = {
      products,
      byId: new Map(products.map((p) => [p.id, p])),
      rails: new Map(),
      fields: new Map(),
      limits: new Map(),
      modified: Date.parse("2026-09-30T08:00:00Z"),
      history: new Map(),
    };
  }
  return g.__vetrinaDemo;
}

const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function keyOf(block: RailBlock, blocks: DemoBlock[]): string {
  const base = block.atts.category ? `category:${block.atts.category}` : `brand:${block.atts.brand}`;
  const n = blocks
    .slice(0, blocks.indexOf(block))
    .filter((b) => b.kind === "rail" && (b.atts.category ? `category:${b.atts.category}` : `brand:${b.atts.brand}`) === base).length;
  return `${base}#${n}`;
}

function defaultFallback(): RailFallback {
  return "menu_order"; // every demo rail shows a category or a brand
}

function railState(key: string): RailState {
  return state().rails.get(key) ?? { pin: [], exclude: [], fallback: defaultFallback() };
}

/** A block's editable fields: its own values under the edits made so far. */
function fieldsOf(block: DemoBlock): FieldValues {
  const spec = FIELD_SPECS[block.name];
  if (!spec) return {};
  const own: FieldValues =
    block.kind === "rail"
      ? {
          eyebrow: block.eyebrow,
          title: block.title,
          backgroundColor: block.background,
          buttonText: block.button.text,
          buttonUrl: block.button.url,
        }
      : { title: block.title ?? "" };
  const edits = state().fields.get(block.path) ?? {};
  return Object.fromEntries(Object.keys(spec).map((field) => [field, edits[field] ?? own[field] ?? ""]));
}

function limitOf(block: RailBlock, key: string): number {
  return state().limits.get(key) ?? Number(block.atts.limit ?? 12);
}

function hashOf(key: string, s: RailState, fields: FieldValues, limit: number): string {
  return createHash("md5").update(JSON.stringify([key, s.pin, s.exclude, s.fallback, fields, limit])).digest("hex");
}

/** The plugin's checks, applied the same way (fields.ts mirrors them). */
function checkFields(blockName: string, fields: FieldValues): FieldValues {
  const clean: FieldValues = {};
  for (const [field, value] of Object.entries(fields)) {
    const problem = fieldProblem(blockName, field, value);
    if (problem) throw new VetrinaError("invalid", `Valore non valido per ${field} (${problem}).`, 400);
    clean[field] = value.trim();
  }
  return clean;
}

function inBrand(product: DemoProduct, brand: string): boolean {
  for (let b: string | null = product.brand; b; b = DEMO_BRAND_PARENT[b] ?? null) {
    if (b === brand) return true;
  }
  return false;
}

function members(block: RailBlock): DemoProduct[] {
  const { category, brand } = block.atts;
  return state().products.filter((p) => (category ? p.categories.includes(category) : inBrand(p, brand ?? "")));
}

const byName = (a: DemoProduct, b: DemoProduct) => a.name.localeCompare(b.name, "it", { sensitivity: "base" });

function sortBy(fallback: RailFallback): (a: DemoProduct, b: DemoProduct) => number {
  switch (fallback) {
    case "date":
      return (a, b) => b.created.localeCompare(a.created) || b.id - a.id;
    case "popularity":
      return (a, b) => b.totalSales - a.totalSales || b.id - a.id;
    case "price":
      return (a, b) => a.price - b.price || a.id - b.id;
    case "price-desc":
      return (a, b) => b.price - a.price || b.id - a.id;
    case "rating":
      return (a, b) => b.id - a.id;
    case "menu_order":
    default:
      return (a, b) => a.menuOrder - b.menuOrder || byName(a, b);
  }
}

/** Visible members in automatic order — what ghb_hub_rail_visible_ids() returns. */
function visibleIds(block: RailBlock, fallback: RailFallback): number[] {
  return members(block)
    .filter((p) => p.inStock)
    .sort(sortBy(fallback))
    .map((p) => p.id);
}

function card(p: DemoProduct): ProductCard {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    type: "variable",
    status: "publish",
    visibility: "visible",
    stockStatus: p.inStock ? "instock" : "outofstock",
    price: p.price,
    priceMax: p.price + 40,
    onSale: p.onSale,
    image: p.image,
    permalink: `https://demo.shop/prodotto/${p.id}`,
    editLink: `https://demo.shop/wp-admin/post.php?post=${p.id}&action=edit`,
    created: p.created,
  };
}

function cards(ids: number[]): ProductCard[] {
  const byId = state().byId;
  return ids.map((id) => {
    const p = byId.get(id);
    return p ? card(p) : { ...card(state().products[0]), id, name: "", missing: true };
  });
}

function railBlocks(): { block: RailBlock; key: string }[] {
  return DEMO_BLOCKS.filter((b): b is RailBlock => b.kind === "rail").map((block) => ({ block, key: keyOf(block, DEMO_BLOCKS) }));
}

function findRail(match: { path?: string; key?: string }): { block: RailBlock; key: string } {
  const found = railBlocks().find((r) => (match.key ? r.key === match.key : r.block.path === match.path));
  if (!found) throw new VetrinaError("not_found", "Questo blocco non è una sezione prodotti.", 404);
  return found;
}

function summary(block: RailBlock, key: string, withProducts: boolean): RailSummary {
  const s = railState(key);
  const slug = block.atts.category ?? block.atts.brand ?? "";
  const limit = limitOf(block, key);
  const fields = fieldsOf(block);
  const rendered = orderIds(visibleIds(block, s.fallback), s.pin, s.exclude).slice(0, limit);
  return {
    key,
    path: block.path,
    attrsHash: hashOf(key, s, fields, limit),
    title: fields.title ?? block.title,
    eyebrow: fields.eyebrow ?? block.eyebrow,
    background: fields.backgroundColor ?? block.background,
    button: { text: fields.buttonText ?? block.button.text, url: fields.buttonUrl ?? block.button.url },
    limit,
    taxonomy: block.atts.category ? "product_cat" : "product_brand",
    terms: [{ id: DEMO_TERM_IDS[slug] ?? 1, slug, name: DEMO_TERM_NAMES[slug] ?? slug, count: members(block).length, link: null }],
    pin: s.pin,
    exclude: s.exclude,
    fallback: s.fallback,
    fallbackDefault: defaultFallback(),
    editable: true,
    fields,
    products: withProducts ? cards(rendered) : [],
  };
}

function staticHash(block: DemoBlock): string {
  return createHash("md5").update(JSON.stringify([block.path, fieldsOf(block)])).digest("hex");
}

function hiddenReason(block: RailBlock, id: number, s: RailState): HiddenItem["reason"] {
  const p = state().byId.get(id);
  if (!p) return "missing";
  if (s.exclude.includes(id)) return "excluded";
  if (!members(block).some((m) => m.id === id)) return "not_in_section";
  if (!p.inStock) return "outofstock";
  return "unknown";
}

export function fixtureSource(): VetrinaSource {
  return {
    kind: "fixture",

    async capabilities() {
      return {
        version: "demo",
        api: 1,
        features: ["homepage", "rail", "rail-visible", "products", "block-write", "history", "rail-limit", "block-fields"],
        fallbacks: ["menu_order", "date", "popularity", "price", "price-desc", "rating"],
        maxIds: 100,
        hideOutOfStock: true,
        frontPageId: 1,
        siteUrl: "https://demo.shop/",
        fields: FIELD_SPECS,
      };
    },

    async homepage(): Promise<Homepage> {
      const keys = new Map(railBlocks().map((r) => [r.block.path, r.key]));
      return {
        pageId: 1,
        title: "Home",
        link: "https://demo.shop/",
        editLink: "https://demo.shop/wp-admin/post.php?post=1&action=edit",
        modifiedGmt: gmt(state().modified),
        blocks: DEMO_BLOCKS.map((b) =>
          b.kind === "rail"
            ? { path: b.path, name: b.name, kind: "rail" as const, rail: summary(b, keys.get(b.path)!, true) }
            : {
                path: b.path,
                name: b.name,
                kind: "static" as const,
                summary: { title: fieldsOf(b).title || b.title, items: b.items, labels: b.labels },
                ...(FIELD_SPECS[b.name] ? { fields: fieldsOf(b), attrsHash: staticHash(b) } : {}),
              },
        ),
      };
    },

    async rail(railKey, opts = {}): Promise<RailDetail> {
      const { block, key } = findRail({ key: railKey });
      const s = railState(key);
      const fallback = opts.fallback ?? s.fallback;
      const visible = visibleIds(block, fallback);
      const ordered = orderIds(visible, s.pin, s.exclude);
      const offset = opts.offset ?? 0;
      const count = opts.count ?? 60;
      const pinned = new Set(s.pin);
      const visibleSet = new Set(visible);
      const hiddenIds = [
        ...s.exclude.filter((id) => visibleSet.has(id)),
        ...s.pin.filter((id) => !visibleSet.has(id) && !s.exclude.includes(id)),
      ];
      const { products: _unused, ...base } = summary(block, key, false);
      return {
        ...base,
        pageId: 1,
        pageLink: "https://demo.shop/",
        modifiedGmt: gmt(state().modified),
        hideOutOfStock: true,
        total: ordered.length,
        offset,
        visible,
        previewFallback: fallback,
        items: cards(ordered.slice(offset, offset + count)).map((c, i) => ({
          ...c,
          position: offset + i + 1,
          pinned: pinned.has(c.id),
        })),
        hidden: cards(hiddenIds).map((c) => ({ ...c, reason: hiddenReason(block, c.id, s), pinned: pinned.has(c.id) })),
      };
    },

    async products(ids) {
      return cards(ids.slice(0, 100));
    },

    async writeRail(input: RailWrite): Promise<RailWriteResult> {
      const st = state();
      const { block, key } = findRail({ path: input.path });
      const current = railState(key);
      const currentFields = fieldsOf(block);
      const currentLimit = limitOf(block, key);
      if (input.expectedModifiedGmt !== gmt(st.modified)) {
        throw new VetrinaError("stale", "La homepage è stata modificata nel frattempo: ricarica.", 409);
      }
      if (input.expectedAttrsHash !== hashOf(key, current, currentFields, currentLimit)) {
        throw new VetrinaError("stale", "La sezione è stata modificata nel frattempo: ricarica.", 409);
      }
      if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
        throw new VetrinaError("invalid", "Numero di prodotti non valido (da 1 a 100).", 400);
      }
      const nextFields = { ...currentFields, ...checkFields(block.name, input.fields ?? {}) };
      const nextLimit = input.limit ?? currentLimit;
      const next: RailState = {
        pin: [...new Set(input.pin.filter((id) => id > 0))].slice(0, 100),
        exclude: [...new Set(input.exclude.filter((id) => id > 0))].slice(0, 100),
        fallback: input.fallback,
      };
      const shortcode = (s: RailState) => {
        const atts = { ...block.atts };
        if (s.pin.length) atts.pin = s.pin.join(",");
        if (s.exclude.length) atts.exclude = s.exclude.join(",");
        if (s.fallback !== defaultFallback()) atts.fallback = s.fallback;
        return `[gh_product_rail ${Object.entries(atts).map(([k, v]) => `${k}="${v}"`).join(" ")}]`;
      };
      const orderChanged = shortcode(next) !== shortcode(current);
      const changed =
        orderChanged || nextLimit !== currentLimit || JSON.stringify(nextFields) !== JSON.stringify(currentFields);
      if (!input.dryRun && changed) {
        if (orderChanged) {
          // Like the plugin's history: one entry per change of order.
          const log = st.history.get(key) ?? [{ ...current, at: st.modified }];
          log.unshift({ ...next, at: st.modified + 60_000 });
          st.history.set(key, log.slice(0, 30));
        }
        st.rails.set(key, next);
        st.fields.set(block.path, nextFields);
        st.limits.set(key, nextLimit);
        st.modified += 60_000;
      }
      const now = railState(key);
      const nowFields = fieldsOf(block);
      const nowLimit = limitOf(block, key);
      return {
        dryRun: input.dryRun ?? false,
        changed,
        before: shortcode(current),
        after: shortcode(next),
        modifiedGmt: gmt(st.modified),
        attrsHash: hashOf(key, now, nowFields, nowLimit),
        rendered: orderIds(visibleIds(block, now.fallback), now.pin, now.exclude).slice(0, nowLimit),
        fields: nowFields,
      };
    },

    async writeBlock(input: BlockWrite): Promise<RailWriteResult> {
      const st = state();
      const block = DEMO_BLOCKS.find((b) => b.path === input.path && b.name === input.blockName);
      if (!block || block.kind === "rail" || !FIELD_SPECS[block.name]) {
        throw new VetrinaError("not_found", "Questo blocco non ha campi modificabili dalla Vetrina.", 422);
      }
      if (input.expectedModifiedGmt !== gmt(st.modified) || input.expectedAttrsHash !== staticHash(block)) {
        throw new VetrinaError("stale", "La homepage è stata modificata nel frattempo: ricarica.", 409);
      }
      const current = fieldsOf(block);
      const next = { ...current, ...checkFields(block.name, input.fields) };
      const changed = JSON.stringify(next) !== JSON.stringify(current);
      if (!input.dryRun && changed) {
        st.fields.set(block.path, next);
        st.modified += 60_000;
      }
      return {
        dryRun: input.dryRun ?? false,
        changed,
        before: "",
        after: "",
        modifiedGmt: gmt(st.modified),
        attrsHash: staticHash(block),
        rendered: [],
        fields: fieldsOf(block),
      };
    },

    async history(key): Promise<RailHistoryState[]> {
      return (state().history.get(key) ?? []).map((s, i) => ({
        pin: s.pin,
        exclude: s.exclude,
        fallback: s.fallback,
        revisionId: 1000 - i,
        dateGmt: gmt(s.at),
        author: "Demo",
      }));
    },
  };
}
