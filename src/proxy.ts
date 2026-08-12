import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, sessionToken } from "@/lib/auth";

/**
 * The login gate (Next's "proxy" file convention, formerly middleware).
 * With APP_PASSWORD set, every page and server action requires
 * the signed session cookie; without it the app stays open (local dev, and
 * deployments that existed before auth — set the variable to turn the lock on).
 *
 * Exempt: /login itself, and /api/cron/* — the cron endpoints are called by
 * headless schedulers that authenticate with CRON_SECRET, never with a cookie.
 *
 * NOTE: reads process.env directly — the one sanctioned exception to "env is
 * read only through src/lib/env.ts", because this bundle runs on the edge
 * runtime where the zod env module (with its server-only import) can't go.
 */

let cachedToken: { password: string; token: string } | null = null;

async function expectedToken(password: string): Promise<string> {
  if (cachedToken?.password !== password) {
    cachedToken = { password, token: await sessionToken(password) };
  }
  return cachedToken.token;
}

export async function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  if (cookie === (await expectedToken(password))) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  // Return the operator to the page they wanted (same-origin paths only).
  if (pathname !== "/" && pathname.startsWith("/") && !pathname.startsWith("//")) {
    url.searchParams.set("from", pathname);
  }
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's static assets and the favicon; API/cron and
  // /login are exempted at runtime above so the matcher stays simple.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
