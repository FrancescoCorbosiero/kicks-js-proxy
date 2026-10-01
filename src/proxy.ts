import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, sessionToken } from "@/lib/auth";
import { isVetrinaHost, requestHost, servedOnVetrinaHost } from "@/lib/vetrina-host";

/**
 * The login gate (Next's "proxy" file convention, formerly middleware).
 * With APP_PASSWORD set, every page and server action requires
 * the signed session cookie; without it the app stays open (local dev, and
 * deployments that existed before auth — set the variable to turn the lock on).
 *
 * Exempt: /login itself, and /api/cron/* — the cron endpoints are called by
 * headless schedulers that authenticate with CRON_SECRET, never with a cookie.
 *
 * The Vetrina's own address (VETRINA_HOST): there "/" is the Vetrina, and the
 * operator tabs, the API and the cron endpoints are not served at all — they
 * stay on the Hub's address. The session cookie is per host, so the Vetrina
 * signs in on its own (same password).
 *
 * NOTE: reads process.env directly — the one sanctioned exception to "env is
 * read only through src/lib/env.ts", because this bundle runs on the edge
 * runtime where the zod env module (with its server-only import) can't go.
 */

/**
 * The install files of the home-screen app. Browsers fetch the manifest
 * without cookies, so behind the gate it would be a redirect to /login and the
 * app would not install. They hold no data: a name, a start page, an icon.
 */
const PUBLIC_APP_FILES = new Set(["/manifest.webmanifest", "/icon", "/apple-icon"]);

let cachedToken: { password: string; token: string } | null = null;

async function expectedToken(password: string): Promise<string> {
  if (cachedToken?.password !== password) {
    cachedToken = { password, token: await sessionToken(password) };
  }
  return cachedToken.token;
}

/**
 * The origin the browser asked for. Behind a reverse proxy req.nextUrl
 * carries the server's own listening address (0.0.0.0:3000 in the
 * container), so redirects are built from what the proxy forwards
 * (X-Forwarded-Proto / X-Forwarded-Host — Caddy sends both), else Host.
 */
function publicOrigin(req: NextRequest): string {
  const first = (value: string | null) => (value ?? "").split(",")[0].trim();
  const host = first(req.headers.get("x-forwarded-host")) || first(req.headers.get("host")) || req.nextUrl.host;
  const proto = first(req.headers.get("x-forwarded-proto")) || req.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

function redirectTo(req: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, publicOrigin(req)), 307);
}

/** Let the request through — on the Vetrina's address, "/" shows the Vetrina. */
function pass(req: NextRequest, onVetrina: boolean): NextResponse {
  if (onVetrina && req.nextUrl.pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/vetrina";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const onVetrina = isVetrinaHost(requestHost(req.headers), process.env.VETRINA_HOST);

  if (onVetrina && !servedOnVetrinaHost(pathname, PUBLIC_APP_FILES)) {
    // An operator page asked on the Vetrina's address: back to the Vetrina.
    // Anything else (the API, a form post) simply does not exist here.
    if (req.method === "GET" || req.method === "HEAD") {
      return redirectTo(req, "/");
    }
    return new NextResponse(null, { status: 404 });
  }

  const password = process.env.APP_PASSWORD;
  if (!password) return pass(req, onVetrina);

  if (pathname === "/login" || pathname.startsWith("/api/cron/") || PUBLIC_APP_FILES.has(pathname)) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  if (cookie === (await expectedToken(password))) {
    return pass(req, onVetrina);
  }

  // Return the operator to the page they wanted (same-origin paths only).
  const from = pathname !== "/" && pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : null;
  return redirectTo(req, from ? `/login?from=${encodeURIComponent(from)}` : "/login");
}

export const config = {
  // Everything except Next's static assets and the favicon; API/cron and
  // /login are exempted at runtime above so the matcher stays simple.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
