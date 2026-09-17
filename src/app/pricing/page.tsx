import { MarginsWorkspace } from "@/components/margins/MarginsWorkspace";
import { DbUnavailable } from "@/components/DbUnavailable";
import { assertSchemaCurrent } from "@/server/db/probe";
import { listBrandCounts, listCategoryCounts } from "@/server/catalog/repo";
import { getActiveConfig } from "@/server/config/repo";
import { getServerDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Scope options handed to the browser. The catalog's family list has no
 * ceiling — a feed whose tree is inferred per model produces one per product —
 * and every option here is serialized into the page.
 */
const OPTION_LIMIT = 300;

/**
 * The Margins tab — the granular pricing-rule admin (the scs-b2b margin
 * panel, on this engine): scoped rules from general to specific, each with a
 * percent, fixed-€ or banded margin plus the operational knobs (rounding,
 * VAT, floors, delta guards, the anomaly guard). The most specific matching
 * rule wins field by field; everything is data, never code.
 */
export default async function PricingPage() {
  const { t } = await getServerDictionary();

  let rules;
  let families;
  let brands;
  try {
    await assertSchemaCurrent();
    const config = await getActiveConfig();
    rules = config.pricingRules;
    // The real catalog tree, so a rule is scoped by PICKING the family the
    // operator already browses by instead of guessing a title substring.
    const [allFamilies, allBrands] = await Promise.all([
      listCategoryCounts(config.source.market),
      listBrandCounts(config.source.market),
    ]);
    // Bounded before it crosses into the browser: these are pickers, and a
    // source with no real taxonomy yields one family per product. Biggest
    // first, and the scopes existing rules already name are always offered —
    // the combobox takes free text for anything else.
    const scoped = new Set(
      rules.flatMap((r) => [r.scope.category ?? "", r.scope.secondaryCategory ?? "", r.scope.brand ?? ""]),
    );
    families = [...allFamilies]
      .sort((a, b) => b.count - a.count)
      .filter((f, i) => i < OPTION_LIMIT || scoped.has(f.category) || scoped.has(f.secondaryCategory));
    brands = [...allBrands]
      .sort((a, b) => b.count - a.count)
      .filter((b, i) => i < OPTION_LIMIT || scoped.has(b.brand));
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.margins.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.margins.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.margins.desc}</p>
      </div>
      <MarginsWorkspace initialRules={rules} families={families} brands={brands} />
    </main>
  );
}
