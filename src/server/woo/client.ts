import "server-only";
import { z } from "zod";
import {
  requestJson,
  requestJsonWithHeaders,
  type RetryPolicy,
  DEFAULT_RETRY,
} from "@/server/adapters/http";
import { env } from "@/lib/env";

/**
 * Thin WooCommerce REST v3 client for the live sync path: paginated reads of
 * products/variations (the pull) and per-parent variation price batches (the
 * apply). Uses the shared retry/backoff HTTP infra; auth is basic
 * consumer-key/secret over HTTPS. Responses are validated loosely — we only
 * depend on a handful of fields and tolerate everything else.
 */

const WooVariationSchema = z.looseObject({
  id: z.number(),
  sku: z.string().nullish(),
  regular_price: z.string().nullish(),
  sale_price: z.string().nullish(),
  global_unique_id: z.string().nullish(),
  stock_quantity: z.union([z.number(), z.string()]).nullish(),
  manage_stock: z.unknown().nullish(),
  stock_status: z.string().nullish(),
  attributes: z.union([z.looseObject({}), z.array(z.unknown())]).nullish(),
});

const WooProductSchema = z.looseObject({
  id: z.number(),
  sku: z.string().nullish(),
  name: z.string().nullish(),
  status: z.string().nullish(),
  permalink: z.string().nullish(),
  date_modified: z.string().nullish(),
  // Needed by the cleanup: the parent pa_taglia option list lives here.
  attributes: z.array(z.unknown()).nullish(),
});

export type WooRestProduct = z.infer<typeof WooProductSchema>;
export type WooRestVariation = z.infer<typeof WooVariationSchema>;

/** One row of a variations/batch response: an id on success, error on failure. */
const BatchRowSchema = z.looseObject({
  id: z.number().optional(),
  error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional(),
});
const BatchResponseSchema = z.looseObject({
  create: z.array(BatchRowSchema).optional(),
  update: z.array(BatchRowSchema).optional(),
  delete: z.array(BatchRowSchema).optional(),
});
export type BatchResultRow = z.infer<typeof BatchRowSchema>;

const VARIATIONS_PER_PAGE = 100;

export class WooClient {
  constructor(
    private readonly baseUrl: string,
    private readonly consumerKey: string,
    private readonly consumerSecret: string,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  private apiUrl(path: string, query: Record<string, string> = {}): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    const root = base.includes("/wp-json") ? base : `${base}/wp-json/wc/v3`;
    const u = new URL(`${root}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private headers(): HeadersInit {
    const token = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString("base64");
    return {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /**
   * One page of published variable products (the only type with size
   * variations), ordered by id so pagination is stable across a long pull.
   * `total` comes from the X-WP-Total header when Woo provides it.
   */
  async getProductsPage(
    page: number,
    perPage: number,
  ): Promise<{ products: WooRestProduct[]; total: number | null }> {
    const { data, headers } = await requestJsonWithHeaders(
      this.apiUrl("products", {
        type: "variable",
        status: "publish",
        orderby: "id",
        order: "asc",
        page: String(page),
        per_page: String(perPage),
      }),
      { method: "GET", headers: this.headers() },
      this.retry,
    );
    const products = z.array(WooProductSchema).parse(data);
    const totalHeader = headers.get("x-wp-total");
    const total = totalHeader != null ? Number.parseInt(totalHeader, 10) : NaN;
    return { products, total: Number.isFinite(total) ? total : null };
  }

  /** All variations of one parent product (paged at 100 — sneaker sizes fit in one). */
  async getAllVariations(productId: number): Promise<WooRestVariation[]> {
    const out: WooRestVariation[] = [];
    for (let page = 1; ; page++) {
      const raw = await requestJson(
        this.apiUrl(`products/${productId}/variations`, {
          page: String(page),
          per_page: String(VARIATIONS_PER_PAGE),
          orderby: "id",
          order: "asc",
        }),
        { method: "GET", headers: this.headers() },
        this.retry,
      );
      const rows = z.array(WooVariationSchema).parse(raw);
      out.push(...rows);
      if (rows.length < VARIATIONS_PER_PAGE) return out;
    }
  }

  /** One full product payload (attributes, meta, everything) — the rebuild input. */
  async getFullProduct(productId: number): Promise<Record<string, unknown>> {
    const raw = await requestJson(
      this.apiUrl(`products/${productId}`),
      { method: "GET", headers: this.headers() },
      this.retry,
    );
    return z.looseObject({ id: z.number() }).parse(raw);
  }

  /** Global attribute taxonomies (to bind pa_taglia by id when a parent lacks it). */
  async getAttributeTaxonomies(): Promise<{ id: number; name: string; slug: string }[]> {
    const raw = await requestJson(
      this.apiUrl("products/attributes", { per_page: "100" }),
      { method: "GET", headers: this.headers() },
      this.retry,
    );
    return z
      .array(z.looseObject({ id: z.number(), name: z.string(), slug: z.string() }))
      .parse(raw);
  }

  /**
   * Write variations: Woo's one structural constraint — variation batches are
   * per-parent-product (POST products/{id}/variations/batch), never global.
   * `create` builds fresh variations (the rebuild), `update` rows may carry any
   * variation fields, `delete` removes variations permanently. Returns the
   * parsed response — created rows carry their new ids, and failed rows embed
   * an `error` object instead of failing the whole batch.
   */
  async batchVariations(
    productId: number,
    payload: {
      create?: Record<string, unknown>[];
      update?: Record<string, unknown>[];
      delete?: number[];
    },
  ): Promise<{ create: BatchResultRow[]; update: BatchResultRow[]; delete: BatchResultRow[] }> {
    if (!payload.create?.length && !payload.update?.length && !payload.delete?.length) {
      return { create: [], update: [], delete: [] };
    }
    const raw = await requestJson(
      this.apiUrl(`products/${productId}/variations/batch`),
      { method: "POST", headers: this.headers(), body: JSON.stringify(payload) },
      this.retry,
    );
    const parsed = BatchResponseSchema.parse(raw);
    return {
      create: parsed.create ?? [],
      update: parsed.update ?? [],
      delete: parsed.delete ?? [],
    };
  }

  /** Update parent-product fields (e.g. the realigned pa_taglia option list). */
  async updateProduct(productId: number, body: Record<string, unknown>): Promise<void> {
    await requestJson(
      this.apiUrl(`products/${productId}`),
      { method: "PUT", headers: this.headers(), body: JSON.stringify(body) },
      this.retry,
    );
  }

  /**
   * Create a parent product and return its new id. Woo enforces SKU uniqueness,
   * so a duplicate SKU throws (product_invalid_sku) — the caller reports it
   * instead of ever making a second product for the same style code.
   */
  async createProduct(body: Record<string, unknown>): Promise<{ id: number }> {
    const raw = await requestJson(
      this.apiUrl("products"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      this.retry,
    );
    return z.looseObject({ id: z.number() }).parse(raw);
  }
}

/** True when the Woo REST credentials are present in env. */
export function wooConfigured(): boolean {
  return !!(env.WOO_BASE_URL && env.WOO_CONSUMER_KEY && env.WOO_CONSUMER_SECRET);
}

/** Build the client from env, or throw a friendly error when unconfigured. */
export function getWooClient(): WooClient {
  if (!wooConfigured()) {
    throw new Error(
      "WooCommerce REST is not configured — set WOO_BASE_URL, WOO_CONSUMER_KEY and WOO_CONSUMER_SECRET.",
    );
  }
  return new WooClient(env.WOO_BASE_URL!, env.WOO_CONSUMER_KEY!, env.WOO_CONSUMER_SECRET!);
}

/** The store base URL for display / snapshot site_url (empty when unset). */
export function wooSiteUrl(): string {
  return env.WOO_BASE_URL ?? "";
}
