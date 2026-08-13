import { getServerDictionary } from "@/i18n/server";
import { assertSchemaCurrent } from "@/server/db/probe";
import { DbUnavailable } from "@/components/DbUnavailable";
import { getPublishState, type PublishPageState } from "@/server/actions/publish";
import { wooSiteUrl } from "@/server/woo/client";
import { PublishWorkspace } from "@/components/publish/PublishWorkspace";

export const dynamic = "force-dynamic";

/**
 * The Publish tab — the catalog→store direction the app was missing.
 *
 * Every other write path adjusts products the store already has; a supplier
 * feed brings genuinely new ones, which until now reached the catalog and
 * stopped there. This lists exactly that delta and creates the selected
 * products on WooCommerce: parent, canonical EU sizes, prices from the margin
 * rules, real feed stock, media.
 */
export default async function PublishPage() {
  const { t } = await getServerDictionary();

  let state: PublishPageState;
  try {
    await assertSchemaCurrent();
    state = await getPublishState();
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.publish.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.publish.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.publish.desc}</p>
      </div>

      <PublishWorkspace
        candidates={state.candidates}
        hasSnapshot={state.hasSnapshot}
        wooConfigured={state.wooConfigured}
        siteUrl={wooSiteUrl()}
      />
    </main>
  );
}
