"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";
import { hubConfig } from "@/config";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The frame at the top of every operator page — quiet on purpose. The dock at
 * the bottom is the navigation; this only says WHERE you are working: the
 * shop this Hub writes to (its own icon and address, a link to the live site),
 * the page you are on once its title has scrolled away, and who is signed in.
 * Transparent over the page's top, it gains a hairline and a blur as soon as
 * content scrolls under it.
 */

/** Height of the bar: the page title counts as "scrolled away" above it. */
const BAR_HEIGHT = 56;

export function TopBar({
  shop,
  user,
}: {
  /** The WooCommerce site; null when no store is configured. */
  shop: { url: string; host: string } | null;
  /** Who Authelia signed in, and where signing out goes; null in local development. */
  user: { name: string; signOutHref: string } | null;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [scrolled, setScrolled] = React.useState(false);
  const [title, setTitle] = React.useState<string | null>(null);

  // One measurement per frame while scrolling: whether anything is under the
  // bar, and whether the page's own title has gone up behind it. Read from
  // the DOM rather than handed down, so every page gets it without opting in.
  React.useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setScrolled(window.scrollY > 4);
      const heading = document.querySelector("main h1");
      setTitle(
        heading && heading.getBoundingClientRect().bottom < BAR_HEIGHT
          ? (heading.textContent?.trim() ?? null)
          : null,
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [pathname]);

  const step = hubConfig.ui.journey.findIndex(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  );
  const eyebrow =
    step >= 0
      ? t.dock.step(step + 1, hubConfig.ui.journey.length)
      : hubConfig.ui.setup.some((href) => pathname === href || pathname.startsWith(`${href}/`))
        ? t.dock.setup
        : null;

  return (
    <header
      className={cn(
        "sticky top-0 z-20 border-b transition-[background-color,border-color] duration-300",
        scrolled ? "border-line bg-bg/90 backdrop-blur-md" : "border-transparent",
      )}
    >
      <div className="relative flex h-14 items-center justify-between gap-3 px-4 sm:px-6">
        <ShopIdentity shop={shop} />

        {/* The page's title, once it has scrolled up behind the bar. */}
        <div
          aria-hidden={title == null}
          className={cn(
            "pointer-events-none absolute left-1/2 hidden -translate-x-1/2 flex-col items-center leading-tight transition duration-300 ease-(--ease-spring) md:flex",
            title ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0",
          )}
        >
          {eyebrow && (
            <span className="text-[10px] font-semibold tracking-wider text-faint uppercase">{eyebrow}</span>
          )}
          <span className="max-w-[40vw] truncate text-sm font-semibold">{title}</span>
        </div>

        <AccountMenu user={user} pathname={pathname} />
      </div>
    </header>
  );
}

/** The shop this Hub writes to: its own icon and address, opening the live site. */
function ShopIdentity({ shop }: { shop: { url: string; host: string } | null }) {
  const { t } = useI18n();

  if (!shop) {
    return (
      <span
        className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-warn"
        title={t.topBar.notConnectedHint}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-warn" />
        {t.topBar.notConnected}
      </span>
    );
  }

  return (
    <a
      href={shop.url}
      target="_blank"
      rel="noreferrer"
      title={t.topBar.openShop}
      className="group -ml-1.5 flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-3 pl-1.5 transition-colors hover:bg-surface-2"
    >
      <ShopIcon url={shop.url} />
      <span className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{shop.host}</span>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
      >
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </a>
  );
}

/** The shop's own favicon; a storefront glyph when it has none to give. */
function ShopIcon({ url }: { url: string }) {
  const [failed, setFailed] = React.useState(false);
  const img = React.useRef<HTMLImageElement>(null);
  const src = React.useMemo(() => {
    try {
      return new URL("/favicon.ico", url).toString();
    } catch {
      return null;
    }
  }, [url]);
  // The image is in the server-rendered HTML, so it can fail before React is
  // listening: onError never fires for that one. Check what already happened.
  React.useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth === 0) setFailed(true);
  }, []);

  if (!src || failed) {
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line bg-surface text-muted">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="h-3.5 w-3.5"
        >
          <path d="M4 9.5 5.5 4h13L20 9.5" />
          <path d="M4 9.5a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0 2.67 2.67 0 0 0 5.33 0" />
          <path d="M5.5 12.5V20h13v-7.5" />
        </svg>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the shop's own icon, on the shop's own host
    <img
      ref={img}
      src={src}
      alt=""
      width={24}
      height={24}
      className="h-6 w-6 shrink-0 rounded-md border border-line bg-white object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/** Who is signed in, the two preferences, and the way out. */
function AccountMenu({
  user,
  pathname,
}: {
  user: { name: string; signOutHref: string } | null;
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

  const initial = user?.name.trim().charAt(0).toUpperCase() || null;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={user ? t.account.signedInAs(user.name) : t.topBar.account}
        onClick={() => setOpenOn(open ? null : pathname)}
        className={cn(
          "flex h-9 items-center gap-2 rounded-full pr-2.5 pl-1 text-[13px] font-medium transition-colors",
          open ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
        )}
      >
        <Avatar initial={initial} />
        {user && <span className="hidden max-w-40 truncate sm:inline">{user.name}</span>}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="animate-pop absolute top-full right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] origin-top-right rounded-2xl border border-line-strong bg-elevated p-2 shadow-pop"
        >
          {user && (
            <div className="flex items-center gap-3 px-2 pt-1.5 pb-2.5">
              <Avatar initial={initial} large />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{user.name}</div>
                <div className="truncate text-xs text-faint">{t.account.signedInAs(user.name)}</div>
              </div>
            </div>
          )}
          <div className={cn("space-y-1 px-2 py-1.5", user && "border-t border-line pt-2.5")}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-muted">{t.topBar.language}</span>
              <LanguageSwitcher />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-muted">{t.topBar.theme}</span>
              <ThemeToggle />
            </div>
          </div>
          {user && (
            <a
              href={user.signOutHref}
              role="menuitem"
              className="mt-1.5 flex items-center justify-between rounded-xl border-t border-line px-2 py-2.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-2"
            >
              {t.account.logout}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="h-4 w-4 text-faint"
              >
                <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
              </svg>
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** The signed-in person's initial; a neutral glyph when nobody is (local dev). */
function Avatar({ initial, large }: { initial: string | null; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-accent/15 font-semibold text-accent-text",
        large ? "h-9 w-9 text-sm" : "h-7 w-7 text-xs",
      )}
    >
      {initial ?? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden
          className={large ? "h-4.5 w-4.5" : "h-4 w-4"}
        >
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      )}
    </span>
  );
}
