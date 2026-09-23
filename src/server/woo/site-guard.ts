import "server-only";
import { compareSites, type SiteMatch } from "@/lib/site";
import { getSnapshotInfo } from "@/server/store-json/repo";
import { wooSiteUrl } from "./client";

/**
 * The snapshot this database holds, against the shop this app is connected to.
 * "unknown" (no snapshot, or no URL on one side) proves nothing either way.
 */
export async function snapshotSiteMatch(): Promise<SiteMatch> {
  const info = await getSnapshotInfo();
  return compareSites(info?.siteUrl, wooSiteUrl());
}

/**
 * Refuse to act on the store when the database belongs to ANOTHER shop.
 *
 * Every table here is one shop's state with no shop column, so two installs
 * sharing a Postgres plan one shop against the other's snapshot and write with
 * the other shop's variation ids. Called before anything that writes to Woo
 * from database state. The pull is exempt on purpose: pulling is how a
 * database is deliberately taken over.
 */
export async function assertSnapshotIsThisStore(): Promise<void> {
  const m = await snapshotSiteMatch();
  if (m.status !== "mismatch") return;
  throw new Error(
    `This database holds the snapshot of ${m.snapshot}, but this app is connected to ${m.connected}. ` +
      `Two shops are sharing one database — nothing was written. Point DATABASE_URL at this shop's own ` +
      `database; pull the store only if you really mean to take this database over.`,
  );
}
