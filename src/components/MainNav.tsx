"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";

/**
 * The app tab bar: catalog-centric sections. The file round-trip flow
 * (/preview) intentionally has no tab — the route still works as a fallback.
 */
export function MainNav() {
  const { t } = useI18n();
  const pathname = usePathname();

  const tabs = [
    { href: "/catalog", label: t.header.navCatalog },
    { href: "/sync", label: t.header.navSync },
    { href: "/import", label: t.header.navImport },
    { href: "/feeds", label: t.header.navFeeds },
  ];

  return (
    <nav className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto text-sm sm:ml-4">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
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
