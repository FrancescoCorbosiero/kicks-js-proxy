/**
 * Session-token derivation shared by the edge middleware and the login action.
 * Pure module — no imports, no env reads — because the middleware bundle runs
 * on the edge runtime where the zod-validated env module (and anything
 * "server-only") must not be pulled in.
 *
 * The token is HMAC-SHA256(APP_PASSWORD, fixed label), hex-encoded: possessing
 * the cookie proves knowledge of the password without storing the password in
 * the cookie. Deterministic by design for a one-operator tool — rotating the
 * password invalidates every session at once, which is exactly the desired
 * "log everyone out" lever.
 */

export const AUTH_COOKIE = "kx-auth";

/** ~90 days: the operator's device stays logged in between work sessions. */
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

const LABEL = "store-hub-session-v1";

export async function sessionToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(LABEL));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
