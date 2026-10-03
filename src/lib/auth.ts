/**
 * Who is signed in, as the app learns it. Signing in is not the app's job: in
 * production Authelia does it, in front of the app (deploy/authelia,
 * docs/auth.md). Caddy checks every request with Authelia and forwards the
 * ones it allows with the person in the Remote-* headers, plus the
 * AUTH_PROXY_SECRET in AUTH_PROXY_HEADER: the proof the request came that way.
 *
 * Pure module — no imports, no env reads — shared by the request proxy
 * (src/proxy.ts), which decides what to trust, and the server components that
 * show who is signed in.
 */

/** Set by Caddy on every request it forwards (header_up, deploy/docker-compose.yml). */
export const AUTH_PROXY_HEADER = "x-auth-proxy-secret";

/** The identity Authelia answers with, copied onto the request by Caddy. */
export const IDENTITY_HEADERS = ["remote-user", "remote-groups", "remote-email", "remote-name"] as const;

/** Authelia's sign-out page: its pages are served on every address under /authelia. */
export const SIGN_OUT_PATH = "/authelia/logout";

/** Constant-time comparison: how long it takes does not tell how much of the secret matched. */
export function secretMatches(candidate: string | null, secret: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(candidate ?? "");
  const b = enc.encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

export interface SignedInUser {
  /** The Authelia username. */
  username: string;
  /** The display name, else the username. */
  name: string;
}

/**
 * The signed-in person. src/proxy.ts removes the Remote-* headers from every
 * request Authelia did not vouch for, so finding them here means it did.
 * Null in local development (no Authelia) and on the public install files.
 */
export function signedInUser(headers: { get(name: string): string | null }): SignedInUser | null {
  const username = headerText(headers.get("remote-user"));
  if (!username) return null;
  return { username, name: headerText(headers.get("remote-name")) || username };
}

/**
 * Header values arrive one byte per character, so a name Authelia sends as
 * UTF-8 ("Niccolò") reads "NiccolÃ²" until its bytes are decoded again.
 */
function headerText(value: string | null): string {
  if (!value) return "";
  const codes = Array.from(value, (c) => c.charCodeAt(0));
  if (codes.some((c) => c > 0xff)) return value; // already text, not bytes
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(codes));
  } catch {
    return value; // not UTF-8: show it as it came
  }
}
