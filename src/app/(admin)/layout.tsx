import type { ReactNode } from "react";
import { headers } from "next/headers";
import { JourneyDock } from "@/components/JourneyDock";
import { SIGN_OUT_PATH, signedInUser } from "@/lib/auth";

/**
 * The operator area: every page of the Hub, and the dock that walks them as
 * one path. No top bar — the page's own title says where you are, the dock
 * says where you are on the way.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Who Authelia signed in; nobody in local development, so no sign-out there.
  const user = signedInUser(await headers());

  return (
    // --dock-clearance: what bottom-sticky bars inside the pages add to their
    // offset so they ride above the dock instead of under it.
    <div className="pb-28 [--dock-clearance:5.5rem]">
      {children}
      <JourneyDock signOut={user ? { href: SIGN_OUT_PATH, name: user.name } : null} />
    </div>
  );
}
