import * as React from "react";
import Link from "next/link";
import { getActiveConfig } from "@/server/config/repo";
import {
  countByOwner,
  listBrandCounts,
  listCatalogPage,
  listCategoryCounts,
  listGenderCounts,
  UNCATEGORIZED,
  type CatalogFreshness,
  type CatalogOwnerFilter,
  type CatalogSort,
  type CategoryCount,
} from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { lockedPriceCounts, skusPinnedTo } from "@/server/overrides/model";
import { getServerDictionary } from "@/i18n/server";
import { buildQuery, type QueryParams } from "@/lib/qs";
import { CatalogFilters } from "@/components/catalog/CatalogFilters";
import { CardImage } from "@/components/catalog/CardImage";
import { ProductDrawer } from "@/components/catalog/ProductDrawer";
import { loadDrawerData } from "@/components/catalog/drawer-data";
import { DbUnavailable } from "@/components/DbUnavailable";
import { LockIcon } from "@/components/icons";
import { assertSchemaCurrent } from "@/server/db/probe";

export const dynamic = "force-dynamic";

const SORTS: CatalogSort[] = ["brand", "title", "added", "fetched", "priceAsc", "priceDesc"];
const FRESHNESS: CatalogFreshness[] = ["all", "fresh", "stale"];
const OWNERS: CatalogOwnerFilter[] = ["all", "kicksdb", "goldensneakers", "woo"];

/** The sidebar tree: category → sub-category counts, Uncategorized last. */
interface CategoryNode {
  category: string; // "" = uncategorized
  count: number;
  children: { name: string; count: number }[];
}

function buildCategoryTree(rows: CategoryCount[]): CategoryNode[] {
  const byCat = new Map<string, CategoryNode>();
  for (const r of rows) {
    const node = byCat.get(r.category) ?? { category: r.category, count: 0, children: [] };
    node.count += r.count;
    if (r.secondaryCategory !== "") {
      node.children.push({ name: r.secondaryCategory, count: r.count });
    }
    byCat.set(r.category, node);
  }
  const nodes = [...byCat.values()];
  const named = nodes.filter((n) => n.category !== "");
  const uncategorized = nodes.find((n) => n.category === "");
  return uncategorized ? [...named, uncategorized] : named;
}

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
  const sort = SORTS.includes(sp.sort as CatalogSort) ? (sp.sort as CatalogSort) : "added";
  const freshness = FRESHNESS.includes(sp.fresh as CatalogFreshness)
    ? (sp.fresh as CatalogFreshness)
    : "all";
  const owner = OWNERS.includes(sp.owner as CatalogOwnerFilter)
    ? (sp.owner as CatalogOwnerFilter)
    : "all";

  // The current URL params — the base every filter/nav/page link merges over.
  const params: QueryParams = {
    market: sp.market,
    brand: sp.brand,
    cat: sp.cat,
    sub: sp.sub,
    gender: sp.gender,
    q: sp.q,
    fresh: sp.fresh,
    owner: sp.owner,
    min: sp.min,
    max: sp.max,
    sort: sp.sort,
    page: sp.page,
  };

  // One overrides read serves the whole page: KicksDB pins (ownership must
  // match what the sync does) and the per-product locked-price chips.
  const overrides = await getOverrides().catch(() => null);
  const pinnedToKicksdb = overrides ? skusPinnedTo(overrides, "kicksdb") : [];
  const lockedCounts = overrides ? lockedPriceCounts(overrides) : new Map<string, number>();

  const [page, brands, categories, genders, ownerCounts] = await Promise.all([
    listCatalogPage(market, ttl, {
      brand: sp.brand,
      category: sp.cat,
      secondaryCategory: sp.sub,
      gender: sp.gender,
      q: sp.q,
      freshness,
      owner,
      pinnedToKicksdb,
      priceMin: toNumber(sp.min),
      priceMax: toNumber(sp.max),
      sort,
      page: toNumber(sp.page) ?? 1,
    }),
    listBrandCounts(market),
    listCategoryCounts(market),
    listGenderCounts(market),
    countByOwner(market, pinnedToKicksdb),
  ]);

  const catalogSize = ownerCounts.total;
  const drawer = sp.product ? await loadDrawerData(market, sp.product, config) : null;
  return {
    market,
    params,
    page,
    brands,
    categoryTree: buildCategoryTree(categories),
    genders: genders.filter((g) => g.gender !== ""),
    catalogSize,
    ownerCounts,
    lockedCounts,
    drawer,
  };
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
  const {
    market,
    params,
    page,
    brands,
    categoryTree,
    genders,
    catalogSize,
    ownerCounts,
    lockedCounts,
    drawer,
  } = data;
  const closeHref = `/catalog${buildQuery({ ...params, product: undefined })}`;

  // Picking a category resets the sub-category; picking a sub keeps its parent.
  const categoryLink = (cat?: string, sub?: string) =>
    `/catalog${buildQuery({ ...params, cat, sub, page: undefined })}`;
  const genderLink = (gender?: string) =>
    `/catalog${buildQuery({ ...params, gender, page: undefined })}`;
  const pageLink = (p: number) =>
    `/catalog${buildQuery({ ...params, page: p === 1 ? undefined : p })}`;
  const ownerLink = (owner?: CatalogOwnerFilter) =>
    `/catalog${buildQuery({ ...params, owner: owner === "all" ? undefined : owner, page: undefined })}`;
  const activeOwner: CatalogOwnerFilter =
    OWNERS.includes(sp.owner as CatalogOwnerFilter) && sp.owner !== "all"
      ? (sp.owner as CatalogOwnerFilter)
      : "all";

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
        {/* Category sidebar (desktop): the silhouette tree, not brands. */}
        {categoryTree.length > 0 && (
          <aside className="sticky top-20 hidden w-52 shrink-0 lg:block">
            <div className="rounded-xl border border-line bg-surface p-2 shadow-xs">
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t.discovery.categories}
              </div>
              <nav className="max-h-[60vh] space-y-0.5 overflow-y-auto text-sm">
                <NavRow
                  href={categoryLink(undefined, undefined)}
                  active={!sp.cat}
                  label={t.discovery.allCategories}
                  count={catalogSize}
                />
                {categoryTree.map((node) => {
                  const token = node.category === "" ? UNCATEGORIZED : node.category;
                  const activeCat = sp.cat === token;
                  return (
                    <div key={token}>
                      <NavRow
                        href={categoryLink(token, undefined)}
                        active={activeCat && !sp.sub}
                        label={node.category === "" ? t.discovery.uncategorized : node.category}
                        count={node.count}
                      />
                      {/* Sub-categories unfold under the active category only. */}
                      {activeCat && node.children.length > 0 && (
                        <div className="ml-3 border-l border-line pl-1.5">
                          {node.children.map((c) => (
                            <NavRow
                              key={c.name}
                              href={categoryLink(token, c.name)}
                              active={sp.sub === c.name}
                              label={c.name}
                              count={c.count}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </nav>
            </div>
          </aside>
        )}

        <div className="min-w-0 flex-1 space-y-4">
          {/* Category chips (mobile) — the active category unfolds its subs. */}
          {categoryTree.length > 0 && (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
              <NavChip
                href={categoryLink(undefined, undefined)}
                active={!sp.cat}
                label={t.discovery.allCategories}
              />
              {categoryTree.map((node) => {
                const token = node.category === "" ? UNCATEGORIZED : node.category;
                const activeCat = sp.cat === token;
                return (
                  <React.Fragment key={token}>
                    <NavChip
                      href={categoryLink(token, undefined)}
                      active={activeCat && !sp.sub}
                      label={`${node.category === "" ? t.discovery.uncategorized : node.category} (${node.count})`}
                    />
                    {activeCat &&
                      node.children.map((c) => (
                        <NavChip
                          key={c.name}
                          href={categoryLink(token, c.name)}
                          active={sp.sub === c.name}
                          label={`↳ ${c.name} (${c.count})`}
                        />
                      ))}
                  </React.Fragment>
                );
              })}
            </div>
          )}

          {/* Provider tabs + gender chips: who prices it, who wears it. */}
          <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1">
            <div className="flex items-center gap-1 rounded-xl border border-line bg-surface p-1 shadow-xs">
              <SourceTab
                href={ownerLink("all")}
                active={activeOwner === "all"}
                label={t.discovery.tabs.all}
                count={ownerCounts.total}
              />
              <SourceTab
                href={ownerLink("kicksdb")}
                active={activeOwner === "kicksdb"}
                label={t.discovery.tabs.kicksdb}
                count={ownerCounts.kicksdb}
                hint={t.discovery.tabs.kicksdbHint}
              />
              <SourceTab
                href={ownerLink("goldensneakers")}
                active={activeOwner === "goldensneakers"}
                label={t.discovery.tabs.goldensneakers}
                count={ownerCounts.goldensneakers}
                hint={t.discovery.tabs.goldensneakersHint}
              />
              <SourceTab
                href={ownerLink("woo")}
                active={activeOwner === "woo"}
                label={t.discovery.tabs.woo}
                count={ownerCounts.woo}
                hint={t.discovery.tabs.wooHint}
              />
            </div>
            {genders.length > 0 && (
              <div className="flex items-center gap-1.5" aria-label={t.discovery.genderLabel}>
                <NavChip href={genderLink(undefined)} active={!sp.gender} label={t.discovery.freshness.all} />
                {genders.map((g) => (
                  <NavChip
                    key={g.gender}
                    href={genderLink(g.gender)}
                    active={sp.gender === g.gender}
                    label={`${t.discovery.genderName(g.gender)} (${g.count})`}
                  />
                ))}
              </div>
            )}
          </div>

          <CatalogFilters params={params} brands={brands} />

          {page.items.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface p-10 text-center text-sm text-muted">
              {catalogSize === 0 ? t.discovery.emptyCatalog : t.discovery.empty}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {page.items.map((item, i) => (
                <Link
                  key={item.sku}
                  href={`/catalog${buildQuery({ ...params, product: item.sku })}`}
                  scroll={false}
                  className="group overflow-hidden rounded-xl border border-line bg-surface shadow-xs transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
                >
                  <CardImage src={item.image} alt={item.title || item.sku} eager={i < 8} />
                  <div className="space-y-1 p-3">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-faint">
                        {item.brand || "—"}
                      </span>
                      {activeOwner === "all" && item.gsOwned && (
                        <span
                          className="shrink-0 rounded border border-line bg-surface-2 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted"
                          title={t.discovery.gsBadgeHint}
                        >
                          GS
                        </span>
                      )}
                      {activeOwner === "all" && item.source === "woo" && !item.gsOwned && (
                        <span
                          className="shrink-0 rounded border border-line bg-surface-2 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted"
                          title={t.discovery.wooBadgeHint}
                        >
                          {t.discovery.wooBadge}
                        </span>
                      )}
                      {(lockedCounts.get(item.sku) ?? 0) > 0 && (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent/15 px-1 py-px text-[9px] font-bold text-accent-text tnum"
                          title={t.discovery.lockedHint(lockedCounts.get(item.sku) ?? 0)}
                        >
                          <LockIcon className="h-2.5 w-2.5" />
                          {lockedCounts.get(item.sku)}
                        </span>
                      )}
                      {/* Freshness is a price-source signal — meaningless for
                          store-only rows, whose data IS the store. */}
                      {!(item.source === "woo" && !item.gsOwned) && (
                        <span
                          className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${item.fresh ? "bg-up" : "bg-skip"}`}
                          title={item.fresh ? t.discovery.freshBadge : t.discovery.staleBadge}
                        />
                      )}
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
      {/* A requested product that can't be loaded must say so — a click that
          silently does nothing is indistinguishable from a broken page. */}
      {sp.product && !drawer && (
        <DrawerNotFound
          sku={sp.product}
          closeHref={closeHref}
          title={t.drawer.notFoundTitle}
          body={t.drawer.notFoundBody}
          closeLabel={t.drawer.close}
        />
      )}
    </main>
  );
}

/** Server-rendered stand-in for the drawer when ?product= can't be resolved. */
function DrawerNotFound({
  sku,
  closeHref,
  title,
  body,
  closeLabel,
}: {
  sku: string;
  closeHref: string;
  title: string;
  body: string;
  closeLabel: string;
}) {
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <Link
        href={closeHref}
        scroll={false}
        aria-label={closeLabel}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />
      <div className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-bg shadow-2xl animate-fade-up sm:max-w-lg">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{title}</div>
            <div className="truncate font-mono text-[11px] text-faint">{sku}</div>
          </div>
          <Link
            href={closeHref}
            scroll={false}
            className="inline-flex h-8 items-center justify-center rounded-md border border-line bg-surface px-3 text-xs font-medium text-ink shadow-xs hover:border-line-strong hover:bg-surface-2"
          >
            {closeLabel}
          </Link>
        </div>
        <p className="p-4 text-sm leading-relaxed text-muted">{body}</p>
      </div>
    </div>
  );
}

function SourceTab({
  href,
  active,
  label,
  count,
  hint,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      title={hint}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-accent text-accent-fg shadow-xs" : "text-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-px text-[10px] font-semibold tnum ${
          active ? "bg-accent-fg/12" : "bg-surface-2 text-faint"
        }`}
      >
        {count}
      </span>
    </Link>
  );
}

function NavRow({
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

function NavChip({ href, active, label }: { href: string; active: boolean; label: string }) {
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
