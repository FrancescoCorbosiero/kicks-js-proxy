import "server-only";
import {
  mapKicksPrices,
  mapKicksProduct,
  mergeProductsBySku,
  type SourcePort,
  type SourceProduct,
} from "@core/core-spine";
import { chunk, requestJson, type RetryPolicy, DEFAULT_RETRY } from "../http";
import { isPoisonedDataError } from "./poison";
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

/** Bisection probes hit deterministic 500s — don't burn the full retry budget. */
const BISECT_RETRY: RetryPolicy = { attempts: 2, backoffMs: 300, timeoutMs: 20_000 };

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

  /**
   * POST /stockx/prices — chunked at 50 skus per call, resilient to poisoned
   * SKUs. KicksDB sometimes 500s on a product's OWN data (e.g. "cannot
   * unmarshal number -4 into ... sell_faster of type uint32"), which used to
   * fail the entire batch — and with it the whole store preview. A failed
   * chunk is now bisected so only the genuinely unfetchable SKUs are dropped
   * (logged; absent from the result, so callers report them as not found).
   *
   * Outages stay loud: when a chunk fails AND two distinct single-SKU canary
   * probes from it also fail, the API itself is down — the original error is
   * rethrown instead of burning hundreds of bisection calls. Exception: a
   * failure carrying the poisoned-data signature (isPoisonedDataError) is
   * never an outage, even when both canaries hit it — poisoned SKUs cluster at
   * the head of the stale queue precisely because they always fail, so both
   * canaries being poisoned is the EXPECTED steady state, not downtime.
   */
  async getPricesBatch(skus: string[], market: string): Promise<SourceProduct[]> {
    // A messy store snapshot can request the same SKU several times — once
    // per duplicate parent product. Send each SKU exactly once.
    skus = [...new Map(skus.map((s) => [s.trim().toUpperCase(), s])).values()];

    const out: SourceProduct[] = [];
    const failed: string[] = [];
    let lastError: unknown;
    let poisonSeen = false;

    /** Fetch one sub-batch into `out`; false (+ lastError) on any failure. */
    const tryPart = async (part: string[], retry: RetryPolicy): Promise<boolean> => {
      try {
        const raw = await requestJson(
          this.url("stockx/prices"),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ market, skus: part, show_sizes: true }),
          },
          retry,
        );
        const parsed = KicksPricesResponseSchema.parse(raw);
        for (const p of parsed.data) out.push(mapKicksPrices(p, market));
        return true;
      } catch (e) {
        lastError = e;
        poisonSeen ||= isPoisonedDataError(e);
        return false;
      }
    };

    const bisect = async (part: string[]): Promise<void> => {
      if (part.length === 0) return;
      if (await tryPart(part, BISECT_RETRY)) return;
      if (part.length === 1) {
        failed.push(part[0]);
        return;
      }
      const mid = Math.ceil(part.length / 2);
      await bisect(part.slice(0, mid));
      await bisect(part.slice(mid));
    };

    for (const part of chunk(skus, this.batchSize)) {
      if (await tryPart(part, this.retry)) continue;
      if (part.length === 1) {
        failed.push(part[0]);
        continue;
      }

      const midIdx = Math.floor(part.length / 2);
      const c1ok = await tryPart([part[0]], BISECT_RETRY);
      const c2ok = await tryPart([part[midIdx]], BISECT_RETRY);
      // Both canaries dead → real outage — UNLESS any failure carried the
      // poisoned-data signature, in which case the canaries themselves are
      // just poisoned SKUs (they gather at the queue head) and bisection
      // must continue.
      if (!c1ok && !c2ok && !poisonSeen) throw lastError;

      // Poisoned data, not an outage: isolate the bad SKUs. Successfully
      // fetched canaries are already in `out` and excluded from the search.
      const rest = part.filter((_, i) => (i !== 0 || !c1ok) && (i !== midIdx || !c2ok));
      await bisect(rest);
    }

    if (failed.length > 0) {
      console.warn(
        `[kicksdb] batch prices: ${failed.length} SKU(s) skipped — the API errors on them: ` +
          `${failed.slice(0, 10).join(", ")}${failed.length > 10 ? ", …" : ""}`,
      );
    }
    // The API may split one SKU across several entries — one plan per SKU,
    // never one per entry.
    return mergeProductsBySku(out);
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

  /** Raw, unparsed batch-prices response — for diagnostics only. */
  async fetchPricesRaw(skus: string[], market: string): Promise<unknown> {
    return requestJson(
      this.url("stockx/prices"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ market, skus: skus.slice(0, 5), show_sizes: true }),
      },
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
