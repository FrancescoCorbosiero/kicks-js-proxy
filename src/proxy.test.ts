import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { AUTH_PROXY_HEADER } from "@/lib/auth";
import { isVetrinaHost, normalizeHost, servedOnVetrinaHost } from "@/lib/vetrina-host";

const VETRINA = "vetrina.resellpiacenza.shop";
const HUB = "hub.resellpiacenza.shop";
const SECRET = "0123456789abcdef0123456789abcdef";

interface Init {
  method?: string;
  /** What Caddy adds: the proxy secret, and the user Authelia vouched for. */
  secret?: string;
  user?: string;
  /** Anything else the client sends, e.g. an identity of its own making. */
  headers?: Record<string, string>;
}

function headersOf(host: string, init: Init): Record<string, string> {
  const headers: Record<string, string> = { host, ...init.headers };
  if (init.secret) headers[AUTH_PROXY_HEADER] = init.secret;
  if (init.user) headers["remote-user"] = init.user;
  return headers;
}

function request(host: string, path: string, init: Init = {}) {
  return new NextRequest(`https://${host}${path}`, { method: init.method ?? "GET", headers: headersOf(host, init) });
}

/** As the container sees a request through Caddy: its own address, the real one in headers. */
function proxied(host: string, path: string, init: Init = {}) {
  return new NextRequest(`http://0.0.0.0:3000${path}`, {
    method: init.method ?? "GET",
    headers: { ...headersOf(host, init), "x-forwarded-host": host, "x-forwarded-proto": "https" },
  });
}

const rewrittenTo = (res: Response) => {
  const target = res.headers.get("x-middleware-rewrite");
  return target ? new URL(target).pathname : null;
};
const redirectedTo = (res: Response) => {
  const target = res.headers.get("location");
  return target ? new URL(target, "https://any.host").pathname : null;
};
const passed = (res: Response) => res.headers.get("x-middleware-next") === "1" || rewrittenTo(res) !== null;
/** The request headers the page gets, when the proxy changed them; null = passed on untouched. */
const forwardedHeaders = (res: Response) => res.headers.get("x-middleware-override-headers")?.split(",") ?? null;

afterEach(() => {
  delete process.env.VETRINA_HOST;
  delete process.env.AUTH_PROXY_SECRET;
});

describe("the Vetrina's own address", () => {
  it("normalizes hosts the way proxies send them", () => {
    expect(normalizeHost("Vetrina.ResellPiacenza.shop:443")).toBe(VETRINA);
    expect(normalizeHost(`${VETRINA}, 10.0.0.1`)).toBe(VETRINA);
    expect(isVetrinaHost(VETRINA, undefined)).toBe(false);
    expect(isVetrinaHost(`${VETRINA}.`, VETRINA)).toBe(true);
    expect(servedOnVetrinaHost("/vetrina/sezione/category.saldi.0", new Set())).toBe(true);
    expect(servedOnVetrinaHost("/vetrinaX", new Set())).toBe(false);
    expect(servedOnVetrinaHost("/login", new Set())).toBe(false);
  });

  it("shows the Vetrina at / and keeps the operator tabs, API and cron off it", async () => {
    process.env.VETRINA_HOST = VETRINA;
    expect(rewrittenTo(await proxy(request(VETRINA, "/")))).toBe("/vetrina");
    expect((await proxy(request(VETRINA, "/vetrina/sezione/category.saldi.0"))).headers.get("x-middleware-next")).toBe("1");

    const tab = await proxy(request(VETRINA, "/catalog"));
    expect(tab.status).toBe(307);
    expect(redirectedTo(tab)).toBe("/");
    expect((await proxy(request(VETRINA, "/api/cron/pull-store", { method: "POST" }))).status).toBe(404);
  });

  it("leaves the Hub's own address exactly as it was", async () => {
    process.env.VETRINA_HOST = VETRINA;
    expect(rewrittenTo(await proxy(request(HUB, "/")))).toBeNull();
    expect((await proxy(request(HUB, "/catalog"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects to the address the browser asked for, never the container's own", async () => {
    process.env.VETRINA_HOST = VETRINA;
    process.env.AUTH_PROXY_SECRET = SECRET;
    const res = await proxy(proxied(VETRINA, "/catalog", { secret: SECRET, user: "shop" }));
    expect(res.headers.get("location")).toBe(`https://${VETRINA}/`);
  });
});

describe("the sign-in, done by Authelia in front of the app", () => {
  it("lets through what Caddy forwards, with the user Authelia vouched for", async () => {
    process.env.VETRINA_HOST = VETRINA;
    process.env.AUTH_PROXY_SECRET = SECRET;

    const page = await proxy(proxied(HUB, "/catalog", { secret: SECRET, user: "operator" }));
    expect(passed(page)).toBe(true);
    expect(forwardedHeaders(page)).toBeNull(); // Remote-User reaches the page as sent

    const vetrina = await proxy(proxied(VETRINA, "/", { secret: SECRET, user: "shop" }));
    expect(rewrittenTo(vetrina)).toBe("/vetrina");
    expect(forwardedHeaders(vetrina)).toBeNull();

    const action = await proxy(proxied(HUB, "/sync", { method: "POST", secret: SECRET, user: "operator" }));
    expect(passed(action)).toBe(true);
  });

  it("refuses anything that did not come through Caddy, whoever it claims to be", async () => {
    process.env.VETRINA_HOST = VETRINA;
    process.env.AUTH_PROXY_SECRET = SECRET;
    for (const init of [{ user: "operator" }, { secret: "wrong", user: "operator" }, { secret: SECRET.slice(0, -1), user: "operator" }]) {
      expect((await proxy(request(HUB, "/catalog", init))).status).toBe(403);
      expect((await proxy(request(VETRINA, "/", init))).status).toBe(403);
      // Not even the Vetrina's routing answers: no redirect for an operator page.
      expect((await proxy(request(VETRINA, "/catalog", init))).status).toBe(403);
      expect((await proxy(request(HUB, "/manifest.webmanifest", init))).status).toBe(403);
      expect((await proxy(request(HUB, "/api/cron/pull-store", { ...init, method: "POST" }))).status).toBe(403);
    }
  });

  it("refuses a page that came through Caddy without a user: forward_auth is missing", async () => {
    process.env.AUTH_PROXY_SECRET = SECRET;
    expect((await proxy(request(HUB, "/", { secret: SECRET }))).status).toBe(403);
    expect((await proxy(request(HUB, "/sync", { method: "POST", secret: SECRET }))).status).toBe(403);
  });

  it("serves the install files and the cron endpoints without a session, dropping any identity they claim", async () => {
    process.env.VETRINA_HOST = VETRINA;
    process.env.AUTH_PROXY_SECRET = SECRET;

    for (const path of ["/manifest.webmanifest", "/icon", "/apple-icon"]) {
      expect(passed(await proxy(request(VETRINA, path, { secret: SECRET })))).toBe(true);
    }
    expect(passed(await proxy(request(HUB, "/api/cron/pull-store", { method: "POST", secret: SECRET })))).toBe(true);

    // Authelia let these through without a session, so a Remote-User on them
    // came from the client (old Caddy versions pass it on): never trusted.
    const forged = { secret: SECRET, user: "operator", headers: { "remote-groups": "operators" } };
    for (const res of [
      await proxy(request(VETRINA, "/manifest.webmanifest", forged)),
      await proxy(request(HUB, "/api/cron/pull-store", { ...forged, method: "POST" })),
    ]) {
      expect(passed(res)).toBe(true);
      expect(forwardedHeaders(res)).not.toBeNull();
      expect(forwardedHeaders(res)).not.toContain("remote-user");
      expect(forwardedHeaders(res)).not.toContain("remote-groups");
    }
  });

  it("answers the container's health check, which calls the app directly", async () => {
    process.env.AUTH_PROXY_SECRET = SECRET;
    const res = await proxy(new NextRequest("http://127.0.0.1:3000/api/health"));
    expect(passed(res)).toBe(true);
  });

  it("is open without a secret (local development), and trusts no identity there", async () => {
    expect(passed(await proxy(request(HUB, "/catalog")))).toBe(true);
    const forged = await proxy(request(HUB, "/catalog", { user: "operator", headers: { "remote-name": "Operator" } }));
    expect(passed(forged)).toBe(true);
    expect(forwardedHeaders(forged)).not.toContain("remote-user");
    expect(forwardedHeaders(forged)).not.toContain("remote-name");
  });
});
