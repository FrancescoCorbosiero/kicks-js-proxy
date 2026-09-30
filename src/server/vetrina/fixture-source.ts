import "server-only";
import { createHash } from "node:crypto";
import { orderIds } from "@/lib/vetrina/order";
import type {
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
import { DEMO_BLOCKS, DEMO_BRAND_PARENT, DEMO_TERM_NAMES, demoProducts, type DemoBlock, type DemoProduct } from "./fixture-data";
import { VetrinaError, type VetrinaSource } from "./source";

/**
 * The demo shop (VETRINA_SOURCE=fixture): the same contract and the same rules
 * as golden-hive-blocks' wc-gh/v1 — membership with sub-brands, sold-out
 * products hidden, pins/exclusions/fallback, stale-write refusal, history —
 * held in memory. Nothing is written anywhere; a restart resets it.
 */

type RailBlock = Extract<DemoBlock, { kind: "rail" }>;

interface DemoState {
  products: DemoProduct[];
  byId: Map<number, DemoProduct>;
  rails: Map<string, RailState>;
  modified: number;
  history: Map<string, (RailState & { at: number })[]>;
}

// Shared across hot reloads and server bundles, like the scheduler's state.
const g = globalThis as { __vetrinaDemo?: DemoState };

function state(): DemoState {
  if (!g.__vetrinaDemo) {
    const products = demoProducts();
    g.__vetrinaDemo = {
      products,
      byId: new Map(products.map((p) => [p.id, p])),
      rails: new Map(),
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

function hashOf(key: string, s: RailState): string {
  return createHash("md5").update(JSON.stringify([key, s.pin, s.exclude, s.fallback])).digest("hex");
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
    onSale: p.categories.includes("saldi-sneakers-outlet"),
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
  const limit = Number(block.atts.limit ?? 12);
  const rendered = orderIds(visibleIds(block, s.fallback), s.pin, s.exclude).slice(0, limit);
  return {
    key,
    path: block.path,
    attrsHash: hashOf(key, s),
    title: block.title,
    eyebrow: block.eyebrow,
    background: block.background,
    button: block.button,
    limit,
    taxonomy: block.atts.category ? "product_cat" : "product_brand",
    terms: [{ id: 1, slug, name: DEMO_TERM_NAMES[slug] ?? slug, count: members(block).length, link: null }],
    pin: s.pin,
    exclude: s.exclude,
    fallback: s.fallback,
    fallbackDefault: defaultFallback(),
    editable: true,
    products: withProducts ? cards(rendered) : [],
  };
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
        features: ["homepage", "rail", "rail-visible", "products", "block-write", "history"],
        fallbacks: ["menu_order", "date", "popularity", "price", "price-desc", "rating"],
        maxIds: 100,
        hideOutOfStock: true,
        frontPageId: 1,
        siteUrl: "https://demo.shop/",
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
            : { path: b.path, name: b.name, kind: "static" as const, summary: { title: b.title, items: b.items, labels: b.labels } },
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
      if (input.expectedModifiedGmt !== gmt(st.modified)) {
        throw new VetrinaError("stale", "La homepage è stata modificata nel frattempo: ricarica.", 409);
      }
      if (input.expectedAttrsHash !== hashOf(key, current)) {
        throw new VetrinaError("stale", "La sezione è stata modificata nel frattempo: ricarica.", 409);
      }
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
      const changed = shortcode(next) !== shortcode(current);
      if (!input.dryRun && changed) {
        const log = st.history.get(key) ?? [{ ...current, at: st.modified }];
        st.rails.set(key, next);
        st.modified += 60_000;
        log.unshift({ ...next, at: st.modified });
        st.history.set(key, log.slice(0, 30));
      }
      const now = railState(key);
      return {
        dryRun: input.dryRun ?? false,
        changed,
        before: shortcode(current),
        after: shortcode(next),
        modifiedGmt: gmt(st.modified),
        attrsHash: hashOf(key, now),
        rendered: orderIds(visibleIds(block, now.fallback), now.pin, now.exclude).slice(0, Number(block.atts.limit ?? 12)),
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
