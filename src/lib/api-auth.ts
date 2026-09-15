import "server-only";
import { env } from "@/lib/env";

/**
 * Basic-auth gate for the round-trip REST routes, mirroring the WP plugin call
 * style (`curl -u "$WP_USER:$WP_APP_PASS"`). Returns null when the request is
 * allowed, or a ready-to-return 401 Response when it isn't.
 *
 * Auth is enforced only when BOTH ROUNDTRIP_BASIC_USER and ROUNDTRIP_BASIC_PASS
 * are configured; otherwise the routes are open (single-operator default).
 */
export function checkBasicAuth(req: Request): Response | null {
  const user = env.ROUNDTRIP_BASIC_USER;
  const pass = env.ROUNDTRIP_BASIC_PASS;
  if (!user || !pass) return null; // not configured => open

  const provided = parseBasicAuth(req.headers.get("authorization"));
  if (provided && timingSafeEqual(provided.user, user) && timingSafeEqual(provided.pass, pass)) {
    return null;
  }

  return Response.json(
    { ok: false, error: "Unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": 'Basic realm="roundtrip"' } },
  );
}

function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

/** Length-then-content compare that doesn't short-circuit on the first byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
