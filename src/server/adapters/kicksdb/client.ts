import "server-only";
import {
  mapKicksPrices,
  mapKicksProduct,
  type SourcePort,
  type SourceProduct,
} from "@core/core-spine";
import { chunk, requestJson, type RetryPolicy, DEFAULT_RETRY } from "../http";
import {
  KicksPricesResponseSchema,
  KicksProductsResponseSchema,
} from "./schemas";

export interface KicksQueryOptions {
  sort: string;
  limit: number;
  display: { traits: boolean; variants: boolean; identifiers: boolean; prices: boolean };
}

export interface KicksDbConfig {
  baseUrl: string; // e.g. https://api.kicks.dev/v3
  apiKey: string; // sent verbatim as the Authorization header (no "Bearer ")
  batchChunkSize?: number; // <= 50 (hard cap), default 50
  query?: KicksQueryOptions; // defaults for the products endpoint (from AppConfig)
  retry?: RetryPolicy;
}

const HARD_MAX_BATCH = 50;

const DEFAULT_QUERY: KicksQueryOptions = {
  sort: "release_date",
  limit: 10,
  display: { traits: true, variants: true, identifiers: true, prices: true },
};

/**
 * Typed KicksDB (StockX) client implementing the SourcePort. Knows about auth,
 * the 50-item batch cap (chunks larger inputs), pagination, and the display
 * params. All JSON is validated with Zod before the pure mappers normalize it.
 */
export class KicksDbSource implements SourcePort {
  private readonly batchSize: number;
  private readonly retry: RetryPolicy;
  private readonly query: KicksQueryOptions;

  constructor(private readonly cfg: KicksDbConfig) {
    this.batchSize = Math.min(cfg.batchChunkSize ?? HARD_MAX_BATCH, HARD_MAX_BATCH);
    this.retry = cfg.retry ?? DEFAULT_RETRY;
    this.query = cfg.query ?? DEFAULT_QUERY;
  }

  private headers(): HeadersInit {
    return {
      Authorization: this.cfg.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private url(path: string, query?: Record<string, string>): string {
    const u = new URL(path.replace(/^\//, ""), this.cfg.baseUrl.replace(/\/?$/, "/"));
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** POST /stockx/prices — chunked at 50 skus per call. */
  async getPricesBatch(skus: string[], market: string): Promise<SourceProduct[]> {
    const out: SourceProduct[] = [];
    for (const part of chunk(skus, this.batchSize)) {
      const raw = await requestJson(
        this.url("stockx/prices"),
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ market, skus: part, show_sizes: true }),
        },
        this.retry,
      );
      const parsed = KicksPricesResponseSchema.parse(raw);
      for (const p of parsed.data) out.push(mapKicksPrices(p, market));
    }
    return out;
  }

  private displayParams(): Record<string, string> {
    const d = this.query.display;
    return {
      "display[traits]": String(d.traits),
      "display[variants]": String(d.variants),
      "display[identifiers]": String(d.identifiers),
      "display[prices]": String(d.prices),
      "display[sizes]": "true",
    };
  }

  /** Raw, unparsed products response — for diagnostics only. */
  async fetchProductsRaw(query: string, market: string): Promise<unknown> {
    return requestJson(
      this.url("stockx/products", { query, market, limit: "1", ...this.displayParams() }),
      { method: "GET", headers: this.headers() },
      this.retry,
    );
  }

  /**
   * GET /stockx/products. Follows pagination (meta.current_page/per_page/total)
   * up to `maxPages` so a query can return more than one page of products.
   */
  async getProduct(query: string, market: string, maxPages = 3): Promise<SourceProduct[]> {
    const out: SourceProduct[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const raw = await requestJson(
        this.url("stockx/products", {
          query,
          market,
          sort: this.query.sort,
          limit: String(this.query.limit),
          page: String(page),
          ...this.displayParams(),
        }),
        { method: "GET", headers: this.headers() },
        this.retry,
      );
      const parsed = KicksProductsResponseSchema.parse(raw);
      for (const p of parsed.data) out.push(mapKicksProduct(p, market));

      const meta = parsed.meta;
      if (!meta || parsed.data.length === 0) break;
      if (meta.current_page * meta.per_page >= meta.total) break;
    }
    return out;
  }
}
