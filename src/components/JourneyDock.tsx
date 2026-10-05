"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";
import type { Dictionary } from "@/i18n/dictionary";
import { hubConfig } from "@/config";
import { EMPTY_DOCK_STATUS, type DockStatus } from "@/lib/dock";

/**
 * The operator area's navigation: a floating dock at the bottom of the
 * screen that draws the work as ONE path — import, catalog, publish, sync,
 * showcase, orders (hubConfig.ui.journey) — starting from the overview. The
 * stretch already walked is lit in gold up to where you are, and each station
 * carries its live number (what's waiting there), polled from /api/dock.
 *
 * Pages that are set up once and rarely touched (hubConfig.ui.setup: margins,
 * taxonomies, automatic categories, feeds) stay off the path, in the menu at the dock's end. Who is
 * signed in, the language and the theme live in the top bar (TopBar.tsx).
 */

type IconName =
  | "home"
  | "import"
  | "catalog"
  | "publish"
  | "sync"
  | "vetrina"
  | "orders"
  | "margins"
  | "taxonomies"
  | "collections"
  | "feeds"
  | "setup";

interface Badge {
  text: string;
  /** "action": work waiting there. "quiet": a plain fact. */
  tone: "action" | "quiet";
}

interface RouteInfo {
  icon: IconName;
  label: string;
  hint: string;
  badge?: Badge;
  busy?: boolean;
}

/** Everything the dock knows how to draw, by href. Unknown hrefs are skipped. */
function describe(
  href: string,
  t: Dictionary,
  s: DockStatus,
  format: (n: number) => string,
): RouteInfo | null {
  switch (href) {
    case "/":
      return { icon: "home", label: t.header.navDashboard, hint: t.dock.homeHint };
    case "/import":
      return { icon: "import", label: t.header.navImport, hint: t.dock.importHint };
    case "/catalog":
      return {
        icon: "catalog",
        label: t.header.navCatalog,
        hint: t.dock.catalogHint(s.catalog),
        badge: s.catalog ? { text: format(s.catalog), tone: "quiet" } : undefined,
      };
    case "/publish":
      return {
        icon: "publish",
        label: t.header.navPublish,
        hint: t.dock.publishHint(s.toPublish),
        badge: s.toPublish ? { text: format(s.toPublish), tone: "action" } : undefined,
      };
    case "/sync": {
      const ago =
        s.lastSyncAt == null
          ? null
          : t.dock.ago(Math.max(0, Math.floor((Date.now() - Date.parse(s.lastSyncAt)) / 60_000)));
      return {
        icon: "sync",
        label: t.header.navSync,
        hint: s.pulling ? t.dock.syncPulling : t.dock.syncHint(ago),
        busy: s.pulling,
      };
    }
    case "/vetrina":
      return { icon: "vetrina", label: t.header.navVetrina, hint: t.dock.vetrinaHint };
    case "/orders":
      return {
        icon: "orders",
        label: t.header.navOrders,
        hint: t.dock.ordersHint(s.openOrders),
        badge: s.openOrders ? { text: format(s.openOrders), tone: "action" } : undefined,
      };
    case "/pricing":
      return { icon: "margins", label: t.header.navMargins, hint: t.dock.marginsHint };
    case "/taxonomies":
      return { icon: "taxonomies", label: t.header.navTaxonomies, hint: t.dock.taxonomiesHint };
    case "/collections":
      return { icon: "collections", label: t.header.navCollections, hint: t.dock.collectionsHint };
    case "/feeds":
      return { icon: "feeds", label: t.header.navFeeds, hint: t.dock.feedsHint };
    default:
      return null;
  }
}

function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

async function fetchStatus(url: string): Promise<DockStatus> {
  const res = await fetch(url, { cache: "no-store" });
  return res.ok ? ((await res.json()) as DockStatus) : EMPTY_DOCK_STATUS;
}

/** The one "you are here" blob: it glides between home, stations and setup. */
function Here() {
  return (
    <motion.span
      layoutId="dock-here"
      aria-hidden
      className="dock-here absolute inset-0 rounded-full bg-accent"
      transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.9 }}
    />
  );
}

export function JourneyDock() {
  const { t, locale } = useI18n();
  const pathname = usePathname();

  const { data, mutate } = useSWR<DockStatus>("/api/dock", fetchStatus, {
    refreshInterval: (latest) => (latest?.pulling ? 5_000 : 60_000),
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
  // Every step changes what waits at the others: refresh on each move.
  React.useEffect(() => {
    void mutate();
  }, [pathname, mutate]);

  const status = data ?? EMPTY_DOCK_STATUS;
  const compact = React.useMemo(
    () => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
    [locale],
  );
  const format = (n: number) => compact.format(n);

  const home = describe("/", t, status, format)!;
  const stations = hubConfig.ui.journey
    .map((href) => ({ href, info: describe(href, t, status, format) }))
    .filter((s): s is { href: string; info: RouteInfo } => s.info != null);
  const setup = hubConfig.ui.setup
    .map((href) => ({ href, info: describe(href, t, status, format) }))
    .filter((s): s is { href: string; info: RouteInfo } => s.info != null);

  const active = stations.findIndex((s) => isActive(s.href, pathname));
  const homeActive = pathname === "/";

  // Which way the path is being walked, so the gold flows segment by segment
  // in that direction instead of every segment snapping at once.
  const [trail, setTrail] = React.useState({ from: active, to: active });
  if (trail.to !== active) setTrail({ from: trail.to, to: active });
  const segmentDelay = (i: number) => {
    const { from, to } = trail;
    if (to > from && i > from && i <= to) return (i - from - 1) * 90;
    if (to < from && i > to && i <= from) return (from - i) * 70;
    return 0;
  };

  return (
    <>
      {/* Content scrolling under the dock fades out instead of colliding with it. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 z-10 h-28 bg-linear-to-t from-bg via-bg/80 to-transparent"
      />
      <nav
        aria-label={t.dock.label}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div className="dock-surface animate-dock-in pointer-events-auto relative flex max-w-full items-center rounded-full border border-line-strong bg-elevated/85 p-1 backdrop-blur-xl sm:p-1.5">
          {/* The path's origin: the overview. */}
          <Link
            href="/"
            aria-current={homeActive ? "page" : undefined}
            aria-label={home.label}
            className={cn(
              "group relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors sm:h-10 sm:w-10",
              homeActive ? "text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {homeActive && <Here />}
            <Icon name="home" className="relative h-5 w-5" />
            <HoverCard title={home.label} hint={home.hint} />
          </Link>

          {stations.map((s, i) => {
            const isHere = i === active;
            const walked = active >= 0 && i < active;
            return (
              <React.Fragment key={s.href}>
                <Segment lit={active >= i} delay={segmentDelay(i)} />
                <Link
                  href={s.href}
                  aria-current={isHere ? "page" : undefined}
                  className={cn(
                    "group relative flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-full text-[13px] font-medium transition-colors sm:h-10 sm:w-auto sm:px-2.5 lg:px-3",
                    isHere
                      ? "text-accent-fg"
                      : walked
                        ? "text-ink hover:bg-surface-2"
                        : "text-muted hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  {isHere && <Here />}
                  <Icon
                    name={s.info.icon}
                    className={cn(
                      "relative h-[18px] w-[18px] shrink-0",
                      walked && "text-accent-text",
                      s.info.busy && "dock-busy",
                    )}
                  />
                  <span
                    className={cn(
                      "relative whitespace-nowrap",
                      isHere ? "sr-only md:not-sr-only md:relative" : "sr-only lg:not-sr-only lg:relative",
                    )}
                  >
                    {s.info.label}
                  </span>
                  {s.info.badge && <StationBadge badge={s.info.badge} onAccent={isHere} />}
                  <HoverCard
                    eyebrow={t.dock.step(i + 1, stations.length)}
                    title={s.info.label}
                    hint={s.info.hint}
                  />
                </Link>
              </React.Fragment>
            );
          })}

          <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-line-strong sm:mx-1.5" />

          <SetupMenu items={setup} pathname={pathname} />
        </div>
      </nav>
    </>
  );
}

/** One stretch of the path between two stations; gold once walked. */
function Segment({ lit, delay }: { lit: boolean; delay: number }) {
  return (
    <span aria-hidden className="relative h-0.5 w-1 shrink-0 overflow-hidden rounded-full bg-line-strong sm:w-3 lg:w-5">
      <span
        className="dock-segment absolute inset-0 origin-left rounded-full bg-accent"
        style={{ transform: lit ? "scaleX(1)" : "scaleX(0)", transitionDelay: `${delay}ms` }}
      />
    </span>
  );
}

function StationBadge({ badge, onAccent }: { badge: Badge; onAccent: boolean }) {
  if (badge.tone === "quiet") {
    return (
      <span
        className={cn(
          "tnum relative hidden text-[11px] font-medium lg:inline",
          onAccent ? "text-accent-fg/65" : "text-faint",
        )}
      >
        {badge.text}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "tnum absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[9.5px] leading-none font-bold sm:relative sm:top-auto sm:right-auto sm:h-[18px] sm:min-w-[18px] sm:px-1.5 sm:text-[10.5px]",
        onAccent ? "bg-accent-fg text-accent" : "dock-waiting bg-accent text-accent-fg",
      )}
    >
      {badge.text}
    </span>
  );
}

/** What a station is for and what waits there — shown above it on hover. */
function HoverCard({ eyebrow, title, hint }: { eyebrow?: string; title: string; hint: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute bottom-full left-1/2 mb-4 hidden w-60 -translate-x-1/2 translate-y-1.5 rounded-xl border border-line-strong bg-elevated p-3 text-left opacity-0 shadow-pop transition duration-200 ease-(--ease-spring) group-hover:translate-y-0 group-hover:opacity-100 group-hover:delay-150 md:block"
    >
      {eyebrow && (
        <span className="block text-[10.5px] font-semibold tracking-wider text-faint uppercase">{eyebrow}</span>
      )}
      <span className="mt-0.5 block text-sm font-semibold text-ink">{title}</span>
      <span className="mt-1 block text-xs leading-relaxed font-normal text-muted">{hint}</span>
    </span>
  );
}

function SetupMenu({
  items,
  pathname,
}: {
  items: { href: string; info: RouteInfo }[];
  pathname: string;
}) {
  const { t } = useI18n();
  // Open "on" a page: navigating anywhere closes it, with no effect to sync.
  const [openOn, setOpenOn] = React.useState<string | null>(null);
  const open = openOn === pathname;
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpenOn(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenOn(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = items.find((i) => isActive(i.href, pathname));

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t.dock.setup}
        onClick={() => setOpenOn(open ? null : pathname)}
        className={cn(
          "relative flex h-9 items-center justify-center gap-2 rounded-full text-[13px] font-medium transition-colors sm:h-10",
          current ? "w-9 text-accent-fg sm:w-auto sm:px-3" : "w-9 sm:w-10",
          !current && (open ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"),
        )}
      >
        {current && <Here />}
        <Icon name={current ? current.info.icon : "setup"} className="relative h-[18px] w-[18px]" />
        {current && <span className="sr-only md:not-sr-only md:relative md:whitespace-nowrap">{current.info.label}</span>}
      </button>

      {open && (
        <div
          role="menu"
          className="animate-pop absolute right-0 bottom-full mb-3 w-80 max-w-[calc(100vw-2rem)] origin-bottom-right rounded-2xl border border-line-strong bg-elevated p-2 shadow-pop"
        >
          <div className="px-2 pt-1.5 pb-2">
            <div className="text-sm font-semibold">{t.dock.setup}</div>
            <div className="text-xs text-faint">{t.dock.setupDesc}</div>
          </div>
          {items.map(({ href, info }) => {
            const here = isActive(href, pathname);
            return (
              <Link
                key={href}
                href={href}
                role="menuitem"
                aria-current={here ? "page" : undefined}
                onClick={() => setOpenOn(null)}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-2 py-2 transition-colors",
                  here ? "bg-accent/15" : "hover:bg-surface-2",
                )}
              >
                <span
                  className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-lg border",
                    here ? "border-accent/40 bg-accent text-accent-fg" : "border-line bg-surface text-muted",
                  )}
                >
                  <Icon name={info.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">{info.label}</span>
                  <span className="block text-xs leading-snug text-faint">{info.hint}</span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {ICONS[name]}
    </svg>
  );
}

const ICONS: Record<IconName, React.ReactNode> = {
  // The start of a line on a transit map: a ring around a point.
  home: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  import: <path d="M12 3v11m0 0-4-4m4 4 4-4M4 16v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2" />,
  catalog: (
    <>
      <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </>
  ),
  publish: (
    <>
      <path d="M12 20V9m0 0-4 4m4-4 4 4" />
      <path d="M5 4h14" />
    </>
  ),
  sync: (
    <>
      <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  vetrina: (
    <>
      <path d="M4 9.5 5.5 4h13L20 9.5" />
      <path d="M4 9.5a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0 2.67 2.67 0 0 0 5.33 0" />
      <path d="M5.5 12.5V20h13v-7.5" />
      <path d="M10 20v-4.5h4V20" />
    </>
  ),
  orders: (
    <>
      <path d="m21 7.5-9-4.5-9 4.5v9l9 4.5 9-4.5v-9Z" />
      <path d="m3 7.5 9 4.5 9-4.5" />
      <path d="M12 12v9" />
    </>
  ),
  margins: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
    </>
  ),
  taxonomies: (
    <>
      <path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9-8-8Z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  collections: (
    <>
      <path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z" />
    </>
  ),
  feeds: (
    <>
      <path d="M5 11a8 8 0 0 1 8 8" />
      <path d="M5 4a15 15 0 0 1 15 15" />
      <circle cx="6" cy="18" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  setup: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
};
