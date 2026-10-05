import type { ReactNode } from "react";
import { headers } from "next/headers";
import { JourneyDock } from "@/components/JourneyDock";
import { TopBar } from "@/components/TopBar";
import { SIGN_OUT_PATH, signedInUser } from "@/lib/auth";
import { wooConfigured, wooSiteUrl } from "@/server/woo/client";

/** The WooCommerce site this Hub writes to, for the top bar; null when unset. */
function shopOf(): { url: string; host: string } | null {
  if (!wooConfigured()) return null;
  try {
    // WOO_BASE_URL may carry the REST path: the site is its origin.
    const url = new URL(wooSiteUrl());
    return { url: url.origin, host: url.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/**
 * The operator area: every page of the Hub between two pieces of chrome. The
 * top bar frames it — which shop, which page, who is signed in — and the dock
 * at the bottom walks the pages as one path.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Who Authelia signed in; nobody in local development, so no sign-out there.
  const user = signedInUser(await headers());

  return (
    // --dock-clearance: what bottom-sticky bars inside the pages add to their
    // offset so they ride above the dock instead of under it.
    <div className="pb-28 [--dock-clearance:5.5rem]">
      <TopBar shop={shopOf()} user={user ? { name: user.name, signOutHref: SIGN_OUT_PATH } : null} />
      {children}
      <JourneyDock />
    </div>
  );
}
