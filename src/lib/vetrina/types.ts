/**
 * The Vetrina's data, as the Hub uses it. The server maps golden-hive-blocks'
 * wc-gh/v1 responses (snake_case) into these (see server/vetrina/schemas.ts);
 * client components import only these types.
 */

import type { RailFallback } from "@/config/schema";

export type { RailFallback };

/** One product as a card: enough to draw it and to join it to Hub data by SKU. */
export interface ProductCard {
  id: number;
  sku: string;
  name: string;
  type: string;
  status: string;
  visibility: string;
  stockStatus: string;
  /** Current shelf price (the minimum, for a product with sizes). */
  price: number | null;
  priceMax: number | null;
  onSale: boolean;
  /** The shop's thumbnail size — never the full image. */
  image: string;
  permalink: string;
  editLink: string;
  created: string | null;
  /** The product no longer exists. */
  missing?: boolean;
}

export interface RailTerm {
  id: number;
  slug: string;
  name: string;
  count: number;
  link: string | null;
}

/** A product rail as the homepage shows it now. */
export interface RailSummary {
  /** Stable name: "category:saldi-sneakers-outlet#0". */
  key: string;
  /** Position in the page's block tree ("8.1") — valid for the page read. */
  path: string;
  /** Fingerprint of the block as read; a write must present it back. */
  attrsHash: string;
  title: string;
  eyebrow: string;
  background: string;
  button: { text: string; url: string };
  limit: number;
  taxonomy: string | null;
  terms: RailTerm[];
  pin: number[];
  exclude: number[];
  fallback: RailFallback;
  fallbackDefault: RailFallback;
  /** False for a rail showing a fixed ids="…" list. */
  editable: boolean;
  /** What the site renders right now, in order. */
  products: ProductCard[];
}

export interface StaticSummary {
  title: string | null;
  items: number | null;
  labels: string[];
}

export type HomeBlock =
  | { path: string; name: string; kind: "rail"; rail: RailSummary }
  | { path: string; name: string; kind: "static"; summary: StaticSummary };

export interface Homepage {
  pageId: number;
  title: string;
  link: string;
  editLink: string;
  /** The page's modified time as read; a write must present it back. */
  modifiedGmt: string;
  blocks: HomeBlock[];
}

export type HiddenReason =
  | "excluded"
  | "outofstock"
  | "hidden"
  | "unpublished"
  | "not_in_section"
  | "missing"
  | "unknown";

export interface RailItem extends ProductCard {
  position: number;
  pinned: boolean;
}

export interface HiddenItem extends ProductCard {
  reason: HiddenReason;
  pinned: boolean;
}

/** A rail opened in the editor: every member, not only the first `limit`. */
export interface RailDetail extends Omit<RailSummary, "products"> {
  pageId: number;
  /** The page on the site ("Vedi sul sito"). */
  pageLink: string;
  modifiedGmt: string;
  hideOutOfStock: boolean;
  /** Members after pins and exclusions. */
  total: number;
  offset: number;
  /** Every visible member in AUTOMATIC order (no pins applied). */
  visible: number[];
  /** The automatic order `visible` was computed with (a preview may differ from `fallback`). */
  previewFallback: RailFallback;
  items: RailItem[];
  hidden: HiddenItem[];
}

/** The part of a rail the customer changes. */
export interface RailState {
  pin: number[];
  exclude: number[];
  fallback: RailFallback;
}

export interface RailWrite extends RailState {
  pageId: number;
  path: string;
  blockName: string;
  expectedModifiedGmt: string;
  expectedAttrsHash: string;
  dryRun?: boolean;
}

export interface RailWriteResult {
  dryRun: boolean;
  changed: boolean;
  before: string;
  after: string;
  modifiedGmt: string;
  attrsHash: string;
  /** Ids the rail renders after the write. */
  rendered: number[];
}

export interface RailHistoryState extends RailState {
  revisionId: number;
  dateGmt: string;
  author: string;
}

export interface Capabilities {
  version: string;
  api: number;
  features: string[];
  fallbacks: RailFallback[];
  maxIds: number;
  hideOutOfStock: boolean;
  frontPageId: number;
  siteUrl: string;
}

/** Why the Vetrina cannot do what was asked — each one has its own message. */
export type VetrinaErrorCode =
  | "not_configured"
  | "plugin_missing"
  | "unauthorized"
  | "stale"
  | "not_found"
  | "invalid"
  | "failed";
