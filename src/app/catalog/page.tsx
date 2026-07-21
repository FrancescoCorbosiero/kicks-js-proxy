import Link from "next/link";
import { getActiveConfig } from "@/server/config/repo";
import {
  listBrandCounts,
  listCatalogPage,
  type CatalogFreshness,
  type CatalogSort,
} from "@/server/catalog/repo";
import { getServerDictionary } from "@/i18n/server";
import { buildQuery, type QueryParams } from "@/lib/qs";
import { CatalogFilters } from "@/components/catalog/CatalogFilters";
import { CardImage } from "@/components/catalog/CardImage";
import { ProductDrawer } from "@/components/catalog/ProductDrawer";
import { loadDrawerData } from "@/components/catalog/drawer-data";
import { DbUnavailable } from "@/components/DbUnavailable";
import { assertSchemaCurrent } from "@/server/db/probe";

export const dynamic = "force-dynamic";

const SORTS: CatalogSort[] = ["brand", "title", "added", "fetched", "priceAsc", "priceDesc"];
const FRESHNESS: CatalogFreshness[] = ["all", "fresh", "stale"];

function toNumber(x: string | undefined): number | undefined {
  if (!x) return undefined;
  const n = Number.parseFloat(x);
  return Number.isFinite(n) ? n : undefined;
}

const eur = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

type Search = Record<string, string | undefined>;

/** Everything the page needs, loaded in one place so a DB failure is one catch. */
async function loadPageData(sp: Search) {
  await assertSchemaCurrent(); // pending migrations must render the remedy page
  const config = await getActiveConfig();

  const market = (sp.market ?? config.source.market).toUpperCase();
  const ttl = config.source.cacheTtlSeconds;
  const sort = SORTS.includes(sp.sort as CatalogSort) ? (sp.sort as CatalogSort) : "brand";
  const freshness = FRESHNESS.includes(sp.fresh as CatalogFreshness)
    ? (sp.fresh as CatalogFreshness)
    : "all";

  // The current URL params — the base every filter/brand/page link merges over.
  const params: QueryParams = {
    market: sp.market,
    brand: sp.brand,
    q: sp.q,
    fresh: sp.fresh,
    min: sp.min,
    max: sp.max,
    sort: sp.sort,
    page: sp.page,
  };

  const [page, brands] = await Promise.all([
    listCatalogPage(market, ttl, {
      brand: sp.brand,
      q: sp.q,
      freshness,
      priceMin: toNumber(sp.min),
      priceMax: toNumber(sp.max),
      sort,
      page: toNumber(sp.page) ?? 1,
    }),
    listBrandCounts(market),
  ]);

  const catalogSize = brands.reduce((n, b) => n + b.count, 0);
  const drawer = sp.product ? await loadDrawerData(market, sp.product, config) : null;
  return { market, params, page, brands, catalogSize, drawer };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const { t } = await getServerDictionary();

  let data: Awaited<ReturnType<typeof loadPageData>>;
  try {
    data = await loadPageData(sp);
  } catch (e) {
    // The landing tab must explain a dead/unmigrated DB, not crash-overlay it.
    return <DbUnavailable error={e} />;
  }
  const { market, params, page, brands, catalogSize, drawer } = data;
  const closeHref = `/catalog${buildQuery({ ...params, product: undefined })}`;

  const brandLink = (brand?: string) =>
    `/catalog${buildQuery({ ...params, brand, page: undefined })}`;
  const pageLink = (p: number) =>
    `/catalog${buildQuery({ ...params, page: p === 1 ? undefined : p })}`;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.discovery.title}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{t.discovery.title}</h1>
          <span className="text-sm font-medium text-muted tnum">
            {t.discovery.total(catalogSize)}
          </span>
          <span className="text-xs text-faint">{market}</span>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.discovery.desc}</p>
      </div>

      <div className="flex items-start gap-6">
        {/* Brand sidebar (desktop) */}
        {brands.length > 0 && (
          <aside className="sticky top-20 hidden w-52 shrink-0 lg:block">
            <div className="rounded-xl border border-line bg-surface p-2 shadow-xs">
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t.discovery.brands}
              </div>
              <nav className="max-h-[60vh] space-y-0.5 overflow-y-auto text-sm">
                <BrandRow
                  href={brandLink(undefined)}
                  active={!sp.brand}
                  label={t.discovery.allBrands}
                  count={catalogSize}
                />
                {brands.map((b) => (
                  <BrandRow
                    key={b.brand}
                    href={brandLink(b.brand)}
                    active={sp.brand === b.brand}
                    label={b.brand}
                    count={b.count}
                  />
                ))}
              </nav>
            </div>
          </aside>
        )}

        <div className="min-w-0 flex-1 space-y-4">
          {/* Brand chips (mobile) */}
          {brands.length > 0 && (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
              <BrandChip href={brandLink(undefined)} active={!sp.brand} label={t.discovery.allBrands} />
              {brands.map((b) => (
                <BrandChip
                  key={b.brand}
                  href={brandLink(b.brand)}
                  active={sp.brand === b.brand}
                  label={`${b.brand} (${b.count})`}
                />
              ))}
            </div>
          )}

          <CatalogFilters params={params} />

          {page.items.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface p-10 text-center text-sm text-muted">
              {catalogSize === 0 ? t.discovery.emptyCatalog : t.discovery.empty}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {page.items.map((item) => (
                <Link
                  key={item.sku}
                  href={`/catalog${buildQuery({ ...params, product: item.sku })}`}
                  scroll={false}
                  className="group overflow-hidden rounded-xl border border-line bg-surface shadow-xs transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
                >
                  <CardImage src={item.image} alt={item.title || item.sku} />
                  <div className="space-y-1 p-3">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-faint">
                        {item.brand || "—"}
                      </span>
                      {item.source !== "kicksdb" && (
                        <span
                          className="shrink-0 rounded-full bg-warn/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-warn"
                          title={t.discovery.gsBadgeHint}
                        >
                          GS
                        </span>
                      )}
                      <span
                        className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${item.fresh ? "bg-up" : "bg-skip"}`}
                        title={item.fresh ? t.discovery.freshBadge : t.discovery.staleBadge}
                      />
                    </div>
                    <div className="line-clamp-2 min-h-[2.4em] text-[13px] font-medium leading-snug">
                      {item.title || item.sku}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted">{item.sku}</div>
                    <div className="flex items-baseline gap-2 pt-0.5">
                      {item.minAsk != null ? (
                        <span className="text-sm font-semibold tnum">
                          {t.discovery.from(eur.format(item.minAsk))}
                        </span>
                      ) : (
                        <span className="text-xs text-faint">{t.discovery.noAsk}</span>
                      )}
                      <span className="ml-auto text-[11px] text-faint tnum">
                        {t.discovery.sizes(item.variantCount)}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Pagination */}
          {page.pageCount > 1 && (
            <div className="flex items-center justify-between border-t border-line pt-4 text-sm">
              <PageLink
                href={pageLink(page.page - 1)}
                disabled={page.page <= 1}
                label={`← ${t.discovery.prev}`}
              />
              <span className="text-xs text-muted tnum">
                {t.discovery.page(page.page, page.pageCount)} · {page.total}
              </span>
              <PageLink
                href={pageLink(page.page + 1)}
                disabled={page.page >= page.pageCount}
                label={`${t.discovery.next} →`}
              />
            </div>
          )}
        </div>
      </div>

      {drawer && <ProductDrawer data={drawer} closeHref={closeHref} />}
    </main>
  );
}

function BrandRow({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
        active ? "bg-accent/12 font-semibold text-accent-text" : "text-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-[11px] text-faint tnum">{count}</span>
    </Link>
  );
}

function BrandChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-accent bg-accent/12 text-accent-text"
          : "border-line bg-surface text-muted hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}

function PageLink({ href, disabled, label }: { href: string; disabled: boolean; label: string }) {
  if (disabled) {
    return <span className="rounded-md px-3 py-1.5 text-faint">{label}</span>;
  }
  return (
    <Link href={href} className="rounded-md px-3 py-1.5 font-medium text-muted hover:bg-surface-2 hover:text-ink">
      {label}
    </Link>
  );
}
