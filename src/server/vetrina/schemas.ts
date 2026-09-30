import "server-only";
import { z } from "zod";
import { RAIL_FALLBACKS } from "@/config/schema";
import type {
  Capabilities,
  HiddenItem,
  Homepage,
  ProductCard,
  RailDetail,
  RailHistoryState,
  RailItem,
  RailSummary,
  RailWriteResult,
} from "@/lib/vetrina/types";

/**
 * golden-hive-blocks' wc-gh/v1 responses, validated loosely (unknown fields
 * are tolerated, so a newer plugin never breaks an older Hub) and mapped to
 * the Hub's camelCase types.
 */

const Fallback = z.enum(RAIL_FALLBACKS).catch("menu_order");
const Ids = z.array(z.coerce.number().int()).catch([]);
// PHP encodes an empty associative array as [] — accept both shapes.
const Atts = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).catch({});

const CardSchema = z.looseObject({
  id: z.number().int(),
  sku: z.string().nullish(),
  name: z.string().nullish(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  visibility: z.string().nullish(),
  stock_status: z.string().nullish(),
  price: z.number().nullish(),
  price_max: z.number().nullish(),
  on_sale: z.boolean().nullish(),
  image: z.string().nullish(),
  permalink: z.string().nullish(),
  edit_link: z.string().nullish(),
  created: z.string().nullish(),
  missing: z.boolean().nullish(),
});

function card(raw: z.infer<typeof CardSchema>): ProductCard {
  return {
    id: raw.id,
    sku: raw.sku ?? "",
    name: raw.name ?? "",
    type: raw.type ?? "",
    status: raw.status ?? "",
    visibility: raw.visibility ?? "visible",
    stockStatus: raw.stock_status ?? "instock",
    price: raw.price ?? null,
    priceMax: raw.price_max ?? null,
    onSale: raw.on_sale ?? false,
    image: raw.image ?? "",
    permalink: raw.permalink ?? "",
    editLink: raw.edit_link ?? "",
    created: raw.created ?? null,
    ...(raw.missing ? { missing: true } : {}),
  };
}

const TermSchema = z.looseObject({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  count: z.number().int().catch(0),
  link: z.string().nullish(),
});

const RailBaseSchema = z.looseObject({
  key: z.string(),
  path: z.string(),
  attrs_hash: z.string(),
  title: z.string().catch(""),
  eyebrow: z.string().catch(""),
  background: z.string().catch("white"),
  button: z.looseObject({ text: z.string().catch(""), url: z.string().catch("") }).catch({ text: "", url: "" }),
  atts: Atts,
  limit: z.number().int(),
  taxonomy: z.string().nullish(),
  terms: z.array(TermSchema).catch([]),
  pin: Ids,
  exclude: Ids,
  fallback: Fallback,
  fallback_default: Fallback,
  editable: z.boolean().catch(true),
  products: z.array(CardSchema).optional(),
});

function railBase(raw: z.infer<typeof RailBaseSchema>): Omit<RailSummary, "products"> {
  return {
    key: raw.key,
    path: raw.path,
    attrsHash: raw.attrs_hash,
    title: raw.title,
    eyebrow: raw.eyebrow,
    background: raw.background,
    button: { text: raw.button.text, url: raw.button.url },
    limit: raw.limit,
    taxonomy: raw.taxonomy ?? null,
    terms: raw.terms.map((t) => ({ id: t.id, slug: t.slug, name: t.name, count: t.count, link: t.link ?? null })),
    pin: raw.pin,
    exclude: raw.exclude,
    fallback: raw.fallback,
    fallbackDefault: raw.fallback_default,
    editable: raw.editable,
  };
}

const HomepageSchema = z.looseObject({
  page_id: z.number().int(),
  title: z.string().catch(""),
  link: z.string().catch(""),
  edit_link: z.string().catch(""),
  modified_gmt: z.string(),
  blocks: z.array(
    z.union([
      z.looseObject({ path: z.string(), name: z.string(), kind: z.literal("rail"), rail: RailBaseSchema }),
      z.looseObject({
        path: z.string(),
        name: z.string(),
        kind: z.literal("static"),
        summary: z
          .looseObject({
            title: z.string().nullish(),
            items: z.number().int().nullish(),
            labels: z.array(z.string()).catch([]),
          })
          .catch({ title: null, items: null, labels: [] }),
      }),
    ]),
  ),
});

export function parseHomepage(data: unknown): Homepage {
  const raw = HomepageSchema.parse(data);
  return {
    pageId: raw.page_id,
    title: raw.title,
    link: raw.link,
    editLink: raw.edit_link,
    modifiedGmt: raw.modified_gmt,
    blocks: raw.blocks.map((b) =>
      b.kind === "rail"
        ? {
            path: b.path,
            name: b.name,
            kind: "rail" as const,
            rail: { ...railBase(b.rail), products: (b.rail.products ?? []).map(card) },
          }
        : {
            path: b.path,
            name: b.name,
            kind: "static" as const,
            summary: { title: b.summary.title ?? null, items: b.summary.items ?? null, labels: b.summary.labels },
          },
    ),
  };
}

const HiddenReason = z
  .enum(["excluded", "outofstock", "hidden", "unpublished", "not_in_section", "missing", "unknown"])
  .catch("unknown");

const RailDetailSchema = RailBaseSchema.extend({
  page_id: z.number().int(),
  page_link: z.string().catch(""),
  modified_gmt: z.string(),
  hide_out_of_stock: z.boolean().catch(false),
  total: z.number().int(),
  offset: z.number().int().catch(0),
  visible: Ids,
  preview_fallback: Fallback,
  items: z.array(CardSchema.extend({ position: z.number().int(), pinned: z.boolean().catch(false) })),
  hidden: z.array(CardSchema.extend({ reason: HiddenReason, pinned: z.boolean().catch(false) })).catch([]),
});

export function parseRailDetail(data: unknown): RailDetail {
  const raw = RailDetailSchema.parse(data);
  return {
    ...railBase(raw),
    pageId: raw.page_id,
    pageLink: raw.page_link,
    modifiedGmt: raw.modified_gmt,
    hideOutOfStock: raw.hide_out_of_stock,
    total: raw.total,
    offset: raw.offset,
    visible: raw.visible,
    previewFallback: raw.preview_fallback,
    items: raw.items.map((i): RailItem => ({ ...card(i), position: i.position, pinned: i.pinned })),
    hidden: raw.hidden.map((h): HiddenItem => ({ ...card(h), reason: h.reason, pinned: h.pinned })),
  };
}

export function parseCards(data: unknown): ProductCard[] {
  return z.looseObject({ products: z.array(CardSchema) }).parse(data).products.map(card);
}

export function parseWriteResult(data: unknown): RailWriteResult {
  const raw = z
    .looseObject({
      dry_run: z.boolean(),
      changed: z.boolean(),
      before: z.string(),
      after: z.string(),
      modified_gmt: z.string(),
      attrs_hash: z.string(),
      rendered: Ids.optional(),
    })
    .parse(data);
  return {
    dryRun: raw.dry_run,
    changed: raw.changed,
    before: raw.before,
    after: raw.after,
    modifiedGmt: raw.modified_gmt,
    attrsHash: raw.attrs_hash,
    rendered: raw.rendered ?? [],
  };
}

export function parseHistory(data: unknown): RailHistoryState[] {
  const raw = z
    .looseObject({
      states: z.array(
        z.looseObject({
          pin: Ids,
          exclude: Ids,
          fallback: Fallback,
          revision_id: z.number().int(),
          date_gmt: z.string(),
          author: z.string().catch(""),
        }),
      ),
    })
    .parse(data);
  return raw.states.map((s) => ({
    pin: s.pin,
    exclude: s.exclude,
    fallback: s.fallback,
    revisionId: s.revision_id,
    dateGmt: s.date_gmt,
    author: s.author,
  }));
}

export function parseCapabilities(data: unknown): Capabilities {
  const raw = z
    .looseObject({
      version: z.string(),
      api: z.number().int(),
      features: z.array(z.string()).catch([]),
      fallbacks: z.array(Fallback).catch([]),
      max_ids: z.number().int().catch(100),
      hide_out_of_stock: z.boolean().catch(false),
      front_page_id: z.number().int().catch(0),
      site_url: z.string().catch(""),
    })
    .parse(data);
  return {
    version: raw.version,
    api: raw.api,
    features: raw.features,
    fallbacks: raw.fallbacks,
    maxIds: raw.max_ids,
    hideOutOfStock: raw.hide_out_of_stock,
    frontPageId: raw.front_page_id,
    siteUrl: raw.site_url,
  };
}
