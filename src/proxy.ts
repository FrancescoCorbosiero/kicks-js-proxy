import { NextResponse, type NextRequest } from "next/server";
import { AUTH_PROXY_HEADER, IDENTITY_HEADERS, SIGN_IN_PATH, secretMatches } from "@/lib/auth";
import { isVetrinaHost, requestHost, servedOnVetrinaHost } from "@/lib/vetrina-host";

/**
 * The sign-in gate (Next's "proxy" file convention, formerly middleware).
 * The app has no login of its own: in production Authelia signs people in, in
 * front of it (docs/auth.md). Caddy checks every request with Authelia and
 * forwards what it allows with who is signed in (Remote-User) and
 * AUTH_PROXY_SECRET in the X-Auth-Proxy-Secret header. With the secret set:
 *
 * - a request without it did not come through Caddy (another container on its
 *   network, say) and is refused, whatever it claims in Remote-User;
 * - a page that arrives without Remote-User was not checked by Authelia (a
 *   proxy config that lost its forward_auth) and is refused, not served open.
 *
 * Without a session: the sign-in page (SIGN_IN_PATH, which Caddy serves at
 * /authelia/), the home-screen app's install files (Authelia lets them
 * through, see PUBLIC_APP_FILES) and /api/cron/* (headless schedulers send
 * CRON_SECRET instead). Without the secret either: /api/health, the
 * container's health check, which calls the app directly. Unset secret =
 * open app (local development).
 *
 * The Remote-* headers reach the app only on requests Authelia vouched for;
 * anywhere else they are removed, so the pages can read them as "who is signed
 * in" (signedInUser in src/lib/auth.ts).
 *
 * The Vetrina's own address (VETRINA_HOST): there "/" is the Vetrina, and the
 * operator tabs, the API and the cron endpoints are not served at all — they
 * stay on the Hub's address.
 *
 * NOTE: reads process.env directly — the one sanctioned exception to "env is
 * read only through src/lib/env.ts", because the zod env module (with its
 * server-only import) does not belong in this bundle.
 */

/**
 * The install files of the home-screen app. Browsers fetch the manifest
 * without cookies, so behind the sign-in it would be a redirect and the app
 * would not install. They hold no data: a name, a start page, an icon.
 * Authelia's bypass rule (prd-web-eu1-01-authelia) lists the same files.
 */
const PUBLIC_APP_FILES = new Set(["/manifest.webmanifest", "/icon", "/apple-icon"]);

/** The container's health check (Dockerfile HEALTHCHECK). */
const HEALTH_PATH = "/api/health";

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

function refuse(): NextResponse {
  return new NextResponse("Forbidden", { status: 403 });
}

/** The request's headers minus every Remote-* one — null when it carries none. */
function withoutIdentity(headers: Headers): Headers | null {
  if (!IDENTITY_HEADERS.some((name) => headers.has(name))) return null;
  const kept = new Headers(headers);
  for (const name of IDENTITY_HEADERS) kept.delete(name);
  return kept;
}

/**
 * Let the request through — on the Vetrina's address, "/" shows the Vetrina.
 * Its Remote-* headers go along only when Authelia vouched for it.
 */
function pass(req: NextRequest, onVetrina: boolean, vouched: boolean): NextResponse {
  const headers = vouched ? null : withoutIdentity(req.headers);
  const init = headers ? { request: { headers } } : undefined;
  if (onVetrina && req.nextUrl.pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/vetrina";
    return NextResponse.rewrite(url, init);
  }
  return NextResponse.next(init);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const secret = process.env.AUTH_PROXY_SECRET;
  const health = pathname === HEALTH_PATH;

  // Not through Caddy: nothing to say to it, not even where the Vetrina is.
  if (secret && !health && !secretMatches(req.headers.get(AUTH_PROXY_HEADER), secret)) {
    return refuse();
  }

  const onVetrina = isVetrinaHost(requestHost(req.headers), process.env.VETRINA_HOST);
  if (onVetrina && !servedOnVetrinaHost(pathname, PUBLIC_APP_FILES) && pathname !== SIGN_IN_PATH) {
    // An operator page asked on the Vetrina's address: back to the Vetrina.
    // Anything else (the API, a form post) simply does not exist here.
    if (req.method === "GET" || req.method === "HEAD") {
      return redirectTo(req, "/");
    }
    return new NextResponse(null, { status: 404 });
  }

  const anonymous =
    health || pathname === SIGN_IN_PATH || PUBLIC_APP_FILES.has(pathname) || pathname.startsWith("/api/cron/");
  if (!secret || anonymous) return pass(req, onVetrina, false);

  if (!req.headers.get("remote-user")) {
    console.warn(`[auth] ${req.method} ${pathname} came through Caddy without a user: is forward_auth in its labels?`);
    return refuse();
  }
  return pass(req, onVetrina, true);
}

export const config = {
  // Everything except Next's static assets and the favicon; the exceptions
  // above are decided at runtime so the matcher stays simple.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
