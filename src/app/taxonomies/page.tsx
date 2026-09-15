import { TaxonomyWorkspace } from "@/components/taxonomy/TaxonomyWorkspace";
import { DbUnavailable } from "@/components/DbUnavailable";
import { assertSchemaCurrent } from "@/server/db/probe";
import { getTaxonomyState } from "@/server/actions/taxonomy";
import { getServerDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The Taxonomies tab: where a product lands on the store, and which of its
 * identity fields get written there at all. Configuration rather than code,
 * because the answer differs per source and per shop.
 */
export default async function TaxonomiesPage() {
  const { t } = await getServerDictionary();

  let initial;
  try {
    await assertSchemaCurrent();
    initial = await getTaxonomyState();
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-7 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.taxonomy.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.taxonomy.title}</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">{t.taxonomy.desc}</p>
      </div>
      <TaxonomyWorkspace initial={initial} />
    </main>
  );
}
