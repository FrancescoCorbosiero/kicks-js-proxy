import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KicksDbSource, __resetSkuFilterSupport } from "./client";

/**
 * These cover the lookup that made twelve perfectly good Nike Mind style codes
 * look like dead SKUs on import: a style code was being run through the BROWSE
 * path — full-text search ordered by release_date, thirty results deep — so in
 * a crowded family the exact match sat past the window and the SKU was filed
 * as "not on StockX".
 */

interface Page {
  data: { sku: string; id?: string; title?: string; brand?: string }[];
  meta?: { current_page: number; per_page: number; total: number } | null;
}

function productRow(sku: string) {
  return { id: `id-${sku}`, sku, title: sku, brand: "Nike", image: "" };
}

/** Captures every request URL and answers from `pages(url)`. */
function stubFetch(pages: (url: URL) => Page | { status: number }) {
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const answer = pages(url);
    if ("status" in answer) {
      return new Response("nope", { status: answer.status });
    }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function source() {
  return new KicksDbSource({
    baseUrl: "https://api.kicks.dev/v3",
    apiKey: "test-key",
    // One attempt: these tests assert on call counts, not on the retry policy.
    retry: { attempts: 1, backoffMs: 1, timeoutMs: 5_000 },
  });
}

beforeEach(() => __resetSkuFilterSupport());
afterEach(() => vi.unstubAllGlobals());

describe("findBySku", () => {
  it("never sends the release_date sort a style-code lookup cannot survive", async () => {
    const calls = stubFetch(() => ({
      data: [productRow("HQ4307-600")],
      meta: { current_page: 1, per_page: 10, total: 1 },
    }));

    const found = await source().findBySku("HQ4307-600", "IT");
    expect(found?.sku).toBe("HQ4307-600");
    expect(calls.every((u) => u.searchParams.get("sort") === null)).toBe(true);
  });

  it("finds the exact match sitting past the old 30-result window", async () => {
    // The API ignores the filter here, then ranks the wanted SKU onto page 4 —
    // beyond the three pages the previous implementation ever read.
    const calls = stubFetch((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      const filler = Array.from({ length: 10 }, (_, i) => productRow(`HQ4309-${page}${i}`));
      return {
        data: page === 4 ? [...filler.slice(0, 9), productRow("HQ4307-600")] : filler,
        meta: { current_page: page, per_page: 10, total: 60 },
      };
    });

    const found = await source().findBySku("HQ4307-600", "IT");
    expect(found?.sku).toBe("HQ4307-600");
    expect(calls.length).toBeGreaterThan(3); // the old path stopped at three
  });

  it("stops at the first exact match instead of paginating on", async () => {
    // The filter is ignored here, so the match has to come off the search path.
    const calls = stubFetch((url) =>
      url.searchParams.has("filters[sku_cleaned]")
        ? { data: [], meta: null }
        : {
            data: [productRow("HQ4307-600"), productRow("HQ4309-600")],
            meta: { current_page: 1, per_page: 10, total: 500 }, // plenty more
          },
    );

    await source().findBySku("HQ4307-600", "IT");
    // One ignored probe + page 1, then it stops: the 490 results behind it are
    // never read. The browse path always spent three pages, match or no match.
    expect(calls).toHaveLength(2);
  });

  it("does not mistake the women's colorway for the men's", async () => {
    stubFetch(() => ({
      data: [productRow("HQ4309-600"), productRow("HQ4307-600")],
      meta: { current_page: 1, per_page: 10, total: 2 },
    }));

    const found = await source().findBySku("HQ4307-600", "IT");
    expect(found?.sku).toBe("HQ4307-600");
  });

  it("returns null — not a throw — when StockX genuinely has no such product", async () => {
    stubFetch(() => ({ data: [], meta: null }));
    await expect(source().findBySku("NOSUCH-001", "IT")).resolves.toBeNull();
  });

  it("throws — not null — when the API could not answer", async () => {
    // "no such product" and "ask again later" must stay distinguishable: the
    // import files the first as rejected and the second as retryable.
    stubFetch(() => ({ status: 429 }));
    await expect(source().findBySku("HQ4307-600", "IT")).rejects.toThrow();
  });

  it("uses the punctuation-free SKU index when the API honors it", async () => {
    const calls = stubFetch((url) =>
      url.searchParams.get("filters[sku_cleaned]") === "HQ4307600"
        ? { data: [productRow("HQ4307-600")], meta: { current_page: 1, per_page: 10, total: 1 } }
        : { data: [], meta: null },
    );

    const found = await source().findBySku("HQ4307-600", "IT");
    expect(found?.sku).toBe("HQ4307-600");
    expect(calls).toHaveLength(1); // answered outright, no search needed
  });

  it("falls back to search — and keeps working — when the filter 400s", async () => {
    const calls = stubFetch((url) =>
      url.searchParams.has("filters[sku_cleaned]")
        ? { status: 400 }
        : { data: [productRow("HQ4307-600")], meta: { current_page: 1, per_page: 10, total: 1 } },
    );

    const s = source();
    expect((await s.findBySku("HQ4307-600", "IT"))?.sku).toBe("HQ4307-600");
    expect((await s.findBySku("HQ4307-600", "IT"))?.sku).toBe("HQ4307-600");

    // The 400 is paid once: after it, no request carries the filter again.
    expect(calls.filter((u) => u.searchParams.has("filters[sku_cleaned]"))).toHaveLength(1);
  });

  it("stops probing a filter the API silently ignores", async () => {
    // 200s that never match: the parameter is being dropped, not understood.
    const calls = stubFetch(() => ({ data: [], meta: null }));

    const s = source();
    for (let i = 0; i < 5; i++) await s.findBySku(`MISS-00${i}`, "IT");

    expect(calls.filter((u) => u.searchParams.has("filters[sku_cleaned]"))).toHaveLength(3);
  });
});

describe("getProduct", () => {
  it("keeps the configured sort — browsing is not looking a style code up", async () => {
    const calls = stubFetch(() => ({
      data: [productRow("A")],
      meta: { current_page: 1, per_page: 10, total: 1 },
    }));

    await source().getProduct("nike mind", "IT");
    expect(calls[0].searchParams.get("sort")).toBe("release_date");
  });
});

describe("findBySku under a failing API", () => {
  it("does not double the load on a rate-limited API", async () => {
    const calls = stubFetch(() => ({ status: 429 }));

    await expect(source().findBySku("HQ4307-600", "IT")).rejects.toThrow();
    // The 429 is the API's answer for every query shape: reaching it twice per
    // SKU would only spend more of a quota that is already exhausted.
    expect(calls).toHaveLength(1);
  });

  it("still reports a 5xx through the fallback search", async () => {
    const calls = stubFetch((url) =>
      url.searchParams.has("filters[sku_cleaned]") ? { status: 500 } : { status: 500 },
    );

    await expect(source().findBySku("HQ4307-600", "IT")).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(1); // probe, then the search that throws
  });

  it("retires a filter that only ever 500s, and keeps serving from search", async () => {
    const calls = stubFetch((url) =>
      url.searchParams.has("filters[sku_cleaned]")
        ? { status: 500 }
        : { data: [productRow("A")], meta: { current_page: 1, per_page: 10, total: 1 } },
    );

    const s = source();
    for (let i = 0; i < 5; i++) expect((await s.findBySku("A", "IT"))?.sku).toBe("A");

    expect(calls.filter((u) => u.searchParams.has("filters[sku_cleaned]"))).toHaveLength(3);
  });
});
