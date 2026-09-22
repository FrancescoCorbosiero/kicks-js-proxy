import "server-only";
import {
  mapKicksPrices,
  mapKicksProduct,
  mergeProductsBySku,
  type SourcePort,
  type SourceProduct,
} from "@core/core-spine";
import { chunk, requestJson, type HttpError, type RetryPolicy, DEFAULT_RETRY } from "../http";
import { skuKey } from "@/lib/skus";
import { isNoProductsFoundError, isPoisonedDataError } from "./poison";
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

/**
 * "No products found" is a settled answer wearing a 500. Retrying it just
 * waits out the backoff to be told the same thing — on a feed-owned store
 * that is minutes of sleep per sync — so it is final on the first reply.
 */
const emptyIsFatal = (status: number | undefined, body: string): boolean =>
  isNoProductsFoundError({ status, body });

const DEFAULT_QUERY: KicksQueryOptions = {
  sort: "release_date",
  limit: 10,
  display: { traits: true, variants: true, identifiers: true, prices: true },
};

/** Result pages a SKU lookup scans before calling a style code absent. */
const SKU_LOOKUP_PAGES = 5;

/** Filtered probes that may come back useless before the filter is written off. */
const SKU_FILTER_BUDGET = 3;

/**
 * Whether this KicksDB build understands `filters[sku_cleaned]` — learned at
 * runtime, remembered for the process. It lives here and not on the instance
 * because getSource() builds a fresh client per request, which would forget
 * the answer and re-probe forever.
 */
let skuFilterSupport: "unknown" | "supported" | "unsupported" = "unknown";
let skuFilterMisses = 0;

/** Reset the learned filter support — tests only. */
export function __resetSkuFilterSupport(): void {
  skuFilterSupport = "unknown";
  skuFilterMisses = 0;
}

/** The punctuation-free spelling KicksDB indexes as `sku_cleaned`. */
function cleanSku(sku: string): string {
  return sku.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

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
    const absent: string[] = [];
    let lastError: unknown;
    let poisonSeen = false;

    /**
     * Fetch one sub-batch into `out`.
     *  - "ok": rows were returned (possibly zero, if the API said so politely)
     *  - "absent": the API answered that it holds NONE of these SKUs. A real
     *    answer, not a failure — nothing to add, nothing to bisect.
     *  - "fail": something went wrong; `lastError` carries it.
     */
    const tryPart = async (
      part: string[],
      retry: RetryPolicy,
    ): Promise<"ok" | "absent" | "fail"> => {
      try {
        const raw = await requestJson(
          this.url("stockx/prices"),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ market, skus: part, show_sizes: true }),
          },
          { ...retry, fatal: emptyIsFatal },
        );
        const parsed = KicksPricesResponseSchema.parse(raw);
        for (const p of parsed.data) out.push(mapKicksPrices(p, market));
        return "ok";
      } catch (e) {
        // "no products found" is the API reporting an empty result through a
        // 500. Reading it as downtime aborted whole syncs of stores whose
        // products simply live on a supplier feed instead of StockX.
        if (isNoProductsFoundError(e)) {
          absent.push(...part);
          return "absent";
        }
        lastError = e;
        poisonSeen ||= isPoisonedDataError(e);
        return "fail";
      }
    };

    const bisect = async (part: string[]): Promise<void> => {
      if (part.length === 0) return;
      if ((await tryPart(part, BISECT_RETRY)) !== "fail") return;
      if (part.length === 1) {
        failed.push(part[0]);
        return;
      }
      const mid = Math.ceil(part.length / 2);
      await bisect(part.slice(0, mid));
      await bisect(part.slice(mid));
    };

    for (const part of chunk(skus, this.batchSize)) {
      if ((await tryPart(part, this.retry)) !== "fail") continue;
      if (part.length === 1) {
        failed.push(part[0]);
        continue;
      }

      const midIdx = Math.floor(part.length / 2);
      const c1 = await tryPart([part[0]], BISECT_RETRY);
      const c2 = await tryPart([part[midIdx]], BISECT_RETRY);
      // Both canaries dead → real outage — UNLESS any failure carried the
      // poisoned-data signature, in which case the canaries themselves are
      // just poisoned SKUs (they gather at the queue head) and bisection
      // must continue. A canary that came back "absent" is not dead at all:
      // the API answered it, so the API is up.
      if (c1 === "fail" && c2 === "fail" && !poisonSeen) throw lastError;

      // Not an outage: isolate the bad SKUs. Canaries already answered for —
      // fetched or reported absent — are excluded from the search.
      const rest = part.filter(
        (_, i) => (i !== 0 || c1 === "fail") && (i !== midIdx || c2 === "fail"),
      );
      await bisect(rest);
    }

    if (failed.length > 0) {
      console.warn(
        `[kicksdb] batch prices: ${failed.length} SKU(s) skipped — the API errors on them: ` +
          `${failed.slice(0, 10).join(", ")}${failed.length > 10 ? ", …" : ""}`,
      );
    }
    if (absent.length > 0) {
      console.info(
        `[kicksdb] batch prices: ${absent.length} SKU(s) not on StockX — ` +
          `priced by their own source, if any.`,
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

  /** One GET /stockx/products page. `sort` is omitted when not given, which
   *  leaves the API on its own relevance ranking. */
  private async searchPage(opts: {
    query: string;
    market: string;
    page?: number;
    sort?: string;
    filters?: Record<string, string>;
  }) {
    const params: Record<string, string> = {
      query: opts.query,
      market: opts.market,
      limit: String(this.query.limit),
      ...this.displayParams(),
    };
    if (opts.page != null) params.page = String(opts.page);
    if (opts.sort) params.sort = opts.sort;
    for (const [k, v] of Object.entries(opts.filters ?? {})) params[`filters[${k}]`] = v;

    try {
      const raw = await requestJson(
        this.url("stockx/products", params),
        { method: "GET", headers: this.headers() },
        { ...this.retry, fatal: emptyIsFatal },
      );
      return KicksProductsResponseSchema.parse(raw);
    } catch (e) {
      // This API states "nothing matched" with a 500 on its prices endpoint.
      // Wherever that signature turns up, it is the empty page it means — and
      // reading it as an error would file a SKU that simply does not exist
      // under "could not verify" instead of "rejected".
      if (isNoProductsFoundError(e)) return { data: [], meta: null };
      throw e;
    }
  }

  /** True once `meta` says the page just read was the last one. */
  private static isLastPage(parsed: { data: unknown[]; meta?: { current_page: number; per_page: number; total: number } | null }): boolean {
    const meta = parsed.meta;
    if (!meta || parsed.data.length === 0) return true;
    return meta.current_page * meta.per_page >= meta.total;
  }

  /**
   * GET /stockx/products. Follows pagination (meta.current_page/per_page/total)
   * up to `maxPages` so a query can return more than one page of products.
   *
   * This is the BROWSE path — a human-typed term, ranked by the configured
   * sort. Looking a style code up is a different question with a different
   * answer: use findBySku.
   */
  async getProduct(query: string, market: string, maxPages = 3): Promise<SourceProduct[]> {
    const out: SourceProduct[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const parsed = await this.searchPage({ query, market, page, sort: this.query.sort });
      for (const p of parsed.data) out.push(mapKicksProduct(p, market));
      if (KicksDbSource.isLastPage(parsed)) break;
    }
    return out;
  }

  /**
   * The one product whose style code IS `sku`, or null when StockX has no such
   * product. Errors THROW — "the API could not answer" and "the answer is no"
   * are different facts and callers act on them differently.
   *
   * Why this exists instead of filtering getProduct(): a style code is not a
   * search term. The browse path sends sort=release_date, which re-orders the
   * matches by date and buries the exact one under every loosely-related shoe
   * in a crowded family — the newest Nike Mind colorway outranks the HQ4307-600
   * you actually asked for. Scanning a fixed 30 results then declared the SKU
   * nonexistent. Here the exact match is what we look for, we stop the moment
   * we have it (usually one call, fewer than the three the old path always
   * spent), and only a genuine miss pays for the deeper scan.
   */
  async findBySku(sku: string, market: string, maxPages = SKU_LOOKUP_PAGES): Promise<SourceProduct | null> {
    const want = skuKey(sku);

    // 1. The exact index, when this API build has one: no ranking to lose to.
    if (skuFilterSupport !== "unsupported") {
      const hit = await this.findViaSkuFilter(sku, market, want);
      if (hit) return hit;
    }

    // 2. Relevance search. Omitting `sort` is the point: an exact style-code
    //    match is what relevance ranks first and what release_date scatters.
    for (let page = 1; page <= maxPages; page++) {
      const parsed = await this.searchPage({ query: sku, market, page });
      const hit = parsed.data.find((p) => skuKey(p.sku) === want);
      if (hit) return mapKicksProduct(hit, market);
      if (KicksDbSource.isLastPage(parsed)) break;
    }
    return null;
  }

  /**
   * One call against KicksDB's punctuation-free SKU index (v3.3 added
   * `sku_cleaned` to `filters`). Treated as a probe, not a dependency: the
   * exact parameter spelling is not confirmed against a live key, so a 4xx
   * (parameter not understood), a run of valid-but-useless answers (parameter
   * ignored), or a run of 5xx (parameter fatal) retires it for the process and
   * the caller's relevance search takes over.
   *
   * Returns null rather than throwing on every failure but one: a 429 is the
   * API rate-limiting the caller, which a second query shape would only hit
   * again, so that one propagates immediately.
   */
  private async findViaSkuFilter(
    sku: string,
    market: string,
    want: string,
  ): Promise<SourceProduct | null> {
    try {
      const parsed = await this.searchPage({
        query: sku,
        market,
        filters: { sku_cleaned: cleanSku(sku) },
      });
      const hit = parsed.data.find((p) => skuKey(p.sku) === want);
      if (hit) {
        skuFilterSupport = "supported";
        return mapKicksProduct(hit, market);
      }
      // A miss proves nothing on its own (the SKU may simply not exist), so
      // only an unbroken run of them, before the filter has ever worked,
      // counts as evidence that it is being ignored.
      if (skuFilterSupport === "unknown" && ++skuFilterMisses >= SKU_FILTER_BUDGET) {
        skuFilterSupport = "unsupported";
      }
      return null;
    } catch (e) {
      const status = (e as HttpError).status;

      // Rate limiting is the whole API's answer, not this parameter's. Running
      // the fallback search would double the load on an endpoint already
      // telling us to slow down, and burn quota to reach the same 429 — so the
      // caller gets the failure now, which is the honest report anyway.
      if (status === 429) throw e;

      // Any other 4xx means this build does not understand the parameter.
      if (status != null && status >= 400 && status < 500) {
        skuFilterSupport = "unsupported";
        return null;
      }

      // 5xx/network: probably the API having a bad moment, in which case the
      // fallback search reports it properly. But a filter that ONLY ever
      // explodes is indistinguishable from one that is not supported, so it
      // spends the same budget as an ignored one.
      if (skuFilterSupport === "unknown" && ++skuFilterMisses >= SKU_FILTER_BUDGET) {
        skuFilterSupport = "unsupported";
      }
      return null;
    }
  }
}
