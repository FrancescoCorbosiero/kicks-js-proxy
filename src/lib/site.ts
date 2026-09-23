/**
 * Which shop a URL names, for telling two shops apart. Pure, so it is tested.
 *
 * The app keeps ONE shop's state per database and nothing in the tables says
 * which shop that is — except the snapshot, which the pull stamps with the
 * site it read. Two installs pointed at one Postgres therefore plan one shop's
 * store against the other's snapshot, and write the result with the wrong
 * variation ids. Comparing the two URLs is how that is caught.
 */

/** "https://www.Shop.com/wp/" → "shop.com/wp". Null when it is not a URL. */
export function siteKey(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  // WordPress may live in a sub-directory; the REST suffix is not part of it.
  const path = u.pathname.replace(/\/wp-json(\/.*)?$/i, "").replace(/\/+$/, "").toLowerCase();
  return host + path;
}

export type SiteMatch =
  | { status: "match" }
  | { status: "mismatch"; snapshot: string; connected: string }
  /** One side is missing or unreadable: nothing proves a mismatch. */
  | { status: "unknown" };

/** Does the snapshot describe the shop this app is connected to? */
export function compareSites(
  snapshotUrl: string | null | undefined,
  connectedUrl: string | null | undefined,
): SiteMatch {
  const a = siteKey(snapshotUrl);
  const b = siteKey(connectedUrl);
  if (a == null || b == null) return { status: "unknown" };
  return a === b ? { status: "match" } : { status: "mismatch", snapshot: a, connected: b };
}
