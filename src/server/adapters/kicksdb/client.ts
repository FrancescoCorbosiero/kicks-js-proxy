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

export interface KicksDbConfig {
  baseUrl: string; // e.g. https://api.kicks.dev/v3
  apiKey: string; // sent verbatim as the Authorization header (no "Bearer ")
  batchChunkSize?: number; // <= 50 (hard cap), default 50
  retry?: RetryPolicy;
}

const HARD_MAX_BATCH = 50;

/**
 * Typed KicksDB (StockX) client implementing the SourcePort. Knows about auth,
 * the 50-item batch cap (chunks larger inputs), pagination, and the display
 * params. All JSON is validated with Zod before the pure mappers normalize it.
 */
export class KicksDbSource implements SourcePort {
  private readonly batchSize: number;
  private readonly retry: RetryPolicy;

  constructor(private readonly cfg: KicksDbConfig) {
    this.batchSize = Math.min(cfg.batchChunkSize ?? HARD_MAX_BATCH, HARD_MAX_BATCH);
    this.retry = cfg.retry ?? DEFAULT_RETRY;
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

  /** GET /stockx/products — single page (caller can page via meta if needed). */
  async getProduct(query: string, market: string): Promise<SourceProduct[]> {
    const raw = await requestJson(
      this.url("stockx/products", {
        query,
        market,
        limit: "10",
        "display[traits]": "true",
        "display[variants]": "true",
        "display[identifiers]": "true",
        "display[prices]": "true",
      }),
      { method: "GET", headers: this.headers() },
      this.retry,
    );
    const parsed = KicksProductsResponseSchema.parse(raw);
    return parsed.data.map((p) => mapKicksProduct(p, market));
  }
}
