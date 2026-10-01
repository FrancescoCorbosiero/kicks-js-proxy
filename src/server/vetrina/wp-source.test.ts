import { afterEach, describe, expect, it, vi } from "vitest";
import { wordpressSource } from "./wp-source";

vi.mock("@/lib/env", () => ({
  env: { WOO_BASE_URL: "https://shop.test", WOO_CONSUMER_KEY: "ck_test", WOO_CONSUMER_SECRET: "cs_test" },
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Run a read to its end: reads retry with backoff, which fake timers skip. */
async function settle<T>(run: () => Promise<T>): Promise<T | unknown> {
  vi.useFakeTimers();
  const outcome = run().then(
    (value) => value,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  return outcome;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * What reaches "Dettagli tecnici" when the site fails: enough to tell a PHP
 * fatal from an unreachable host from a plugin that answers in another shape.
 */
describe("wc-gh/v1 failures, as the Vetrina reports them", () => {
  it("a PHP fatal keeps WordPress's code and the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json(500, { code: "internal_server_error", message: "C'è stato un errore critico.", data: { status: 500 } }),
    ));
    const error = await settle(() => wordpressSource().homepage());
    expect(error).toMatchObject({ code: "failed", status: 500 });
    expect((error as Error).message).toBe("C'è stato un errore critico. (internal_server_error, HTTP 500)");
  });

  it("an unreachable site says why, not just 'fetch failed'", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND shop.test" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(refused)));
    const error = await settle(() => wordpressSource().homepage());
    expect(error).toMatchObject({ code: "failed" });
    expect((error as Error).message).toContain("fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND shop.test)");
  });

  it("an answer in an unexpected shape names the route and the field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { page_id: "front", blocks: [] })));
    const error = await settle(() => wordpressSource().homepage());
    expect(error).toMatchObject({ code: "failed" });
    expect((error as Error).message).toMatch(/^Risposta inattesa da wc-gh\/v1\/homepage:/);
    expect((error as Error).message).toContain("page_id");
  });

  it("a publish sends the section's changed fields and size, and nothing when none change", async () => {
    const bodies: unknown[] = [];
    const ok = { dry_run: false, changed: true, before: "", after: "", modified_gmt: "2026-09-30 10:00:00", attrs_hash: "h", fields: {} };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return json(200, ok);
    }));
    const base = {
      pageId: 7, path: "8.1", blockName: "golden-hive/shortcode-wrapper",
      expectedModifiedGmt: "2026-09-30 09:00:00", expectedAttrsHash: "a",
      pin: [3], exclude: [], fallback: "menu_order" as const,
    };
    await wordpressSource().writeRail({ ...base, fields: { title: "SALDI AUTUNNO" }, limit: 6 });
    await wordpressSource().writeRail(base);
    expect(bodies[0]).toMatchObject({ rail: { pin: [3], limit: 6 }, attrs: { title: "SALDI AUTUNNO" } });
    expect(bodies[1]).not.toHaveProperty("attrs");
    expect((bodies[1] as { rail: object }).rail).not.toHaveProperty("limit");
  });

  it("a site without the plugin is told apart from a site that is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json(404, { code: "rest_no_route", message: "No route was found.", data: { status: 404 } }),
    ));
    const error = await settle(() => wordpressSource().homepage());
    expect(error).toMatchObject({ code: "plugin_missing", status: 404 });
  });
});
