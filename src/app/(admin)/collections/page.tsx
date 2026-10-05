import { CollectionsWorkspace } from "@/components/collections/CollectionsWorkspace";
import { DbUnavailable } from "@/components/DbUnavailable";
import { assertSchemaCurrent } from "@/server/db/probe";
import { loadState } from "@/server/collections/service";
import { getServerDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Automatic categories: WooCommerce categories that fill and empty themselves
 * by a rule on the products' tags, brands, attributes and a few facts — the
 * way Shopify's automated collections do.
 */
export default async function CollectionsPage() {
  const { t } = await getServerDictionary();

  let initial;
  try {
    await assertSchemaCurrent();
    initial = await loadState();
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-7 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.collections.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.collections.title}</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">{t.collections.desc}</p>
      </div>
      <CollectionsWorkspace initial={initial} />
    </main>
  );
}
