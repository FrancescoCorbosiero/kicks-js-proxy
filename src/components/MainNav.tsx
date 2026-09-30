"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";
import { hubConfig } from "@/config";

/**
 * The app tab bar. Which tabs exist, and in what order, is code config
 * (hubConfig.ui.nav) — the old UI gets leaner by removing entries there. The
 * file round-trip flow (/preview) intentionally has no tab — the route still
 * works as a fallback.
 */
export function MainNav() {
  const { t } = useI18n();
  const pathname = usePathname();

  const labels: Record<string, string> = {
    "/vetrina": t.header.navVetrina,
    "/": t.header.navDashboard,
    "/catalog": t.header.navCatalog,
    "/orders": t.header.navOrders,
    "/pricing": t.header.navMargins,
    "/sync": t.header.navSync,
    "/publish": t.header.navPublish,
    "/import": t.header.navImport,
    "/taxonomies": t.header.navTaxonomies,
    "/feeds": t.header.navFeeds,
  };
  const tabs = hubConfig.ui.nav
    .filter((href) => labels[href] != null)
    .map((href) => ({ href, label: labels[href] }));

  return (
    <nav className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto text-sm sm:ml-4">
      {tabs.map((tab) => {
        const active =
          tab.href === "/" ? pathname === "/" : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 font-medium transition-colors",
              active
                ? "bg-surface-2 text-ink"
                : "text-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
