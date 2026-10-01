import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { AUTH_COOKIE, sessionToken } from "@/lib/auth";
import { isVetrinaHost, normalizeHost, servedOnVetrinaHost } from "@/lib/vetrina-host";

const VETRINA = "vetrina.resellpiacenza.shop";
const HUB = "hub.resellpiacenza.shop";

function request(host: string, path: string, init: { method?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { host };
  if (init.cookie) headers.cookie = `${AUTH_COOKIE}=${init.cookie}`;
  return new NextRequest(`https://${host}${path}`, { method: init.method ?? "GET", headers });
}

/** As the container sees a request through Caddy: its own address, the real one in headers. */
function proxied(host: string, path: string) {
  return new NextRequest(`http://0.0.0.0:3000${path}`, {
    headers: { host, "x-forwarded-host": host, "x-forwarded-proto": "https" },
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

afterEach(() => {
  delete process.env.VETRINA_HOST;
  delete process.env.APP_PASSWORD;
});

describe("the Vetrina's own address", () => {
  it("normalizes hosts the way proxies send them", () => {
    expect(normalizeHost("Vetrina.ResellPiacenza.shop:443")).toBe(VETRINA);
    expect(normalizeHost(`${VETRINA}, 10.0.0.1`)).toBe(VETRINA);
    expect(isVetrinaHost(VETRINA, undefined)).toBe(false);
    expect(isVetrinaHost(`${VETRINA}.`, VETRINA)).toBe(true);
    expect(servedOnVetrinaHost("/vetrina/sezione/category.saldi.0", new Set())).toBe(true);
    expect(servedOnVetrinaHost("/vetrinaX", new Set())).toBe(false);
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
    process.env.APP_PASSWORD = "a-long-enough-password";
    expect((await proxy(proxied(VETRINA, "/catalog"))).headers.get("location")).toBe(`https://${VETRINA}/`);
    expect((await proxy(proxied(HUB, "/orders"))).headers.get("location")).toBe(`https://${HUB}/login?from=%2Forders`);
  });

  it("asks for the password on both addresses, then shows the Vetrina at /", async () => {
    process.env.VETRINA_HOST = VETRINA;
    process.env.APP_PASSWORD = "a-long-enough-password";
    expect(redirectedTo(await proxy(request(VETRINA, "/")))).toBe("/login");
    expect(redirectedTo(await proxy(request(HUB, "/catalog")))).toBe("/login");

    const token = await sessionToken("a-long-enough-password");
    expect(rewrittenTo(await proxy(request(VETRINA, "/", { cookie: token })))).toBe("/vetrina");
    expect((await proxy(request(VETRINA, "/login"))).headers.get("x-middleware-next")).toBe("1");
  });
});
