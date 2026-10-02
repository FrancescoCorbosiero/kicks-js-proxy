/**
 * The Vetrina's own address (VETRINA_HOST, e.g. vetrina.resellpiacenza.shop):
 * the same app and deployment, answering there with the Vetrina only. Pure —
 * shared by the request proxy (src/proxy.ts) and the Vetrina's server layout.
 */

/** "Vetrina.Example.com:443" → "vetrina.example.com"; the first of a forwarded list. */
export function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Whether a request's host is the configured Vetrina host (never, when none is set). */
export function isVetrinaHost(requestHost: string | null | undefined, configured: string | null | undefined): boolean {
  const target = normalizeHost(configured);
  return target !== "" && normalizeHost(requestHost) === target;
}

/** The request's host as the client asked for it: the reverse proxy's X-Forwarded-Host, else Host. */
export function requestHost(headers: { get(name: string): string | null }): string {
  return normalizeHost(headers.get("x-forwarded-host") ?? headers.get("host"));
}

/**
 * What the Vetrina host serves: its home ("/" is the Vetrina), the Vetrina's
 * pages, and the home-screen app's install files. Everything else — the
 * operator tabs, the API, the cron endpoints — stays on the Hub's own address.
 * (The sign-in pages are Authelia's, under /authelia: Caddy sends those there.)
 */
export function servedOnVetrinaHost(pathname: string, installFiles: ReadonlySet<string>): boolean {
  return (
    pathname === "/" ||
    pathname === "/vetrina" ||
    pathname.startsWith("/vetrina/") ||
    installFiles.has(pathname)
  );
}
