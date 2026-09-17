import { getServerDictionary } from "@/i18n/server";
import { assertSchemaCurrent } from "@/server/db/probe";
import { DbUnavailable } from "@/components/DbUnavailable";
import { getPublishState, type PublishPageState } from "@/server/actions/publish";
import { wooSiteUrl } from "@/server/woo/client";
import { PublishWorkspace } from "@/components/publish/PublishWorkspace";
import type { PublishSourceLens } from "@/lib/publish-page";
import type { QueryParams } from "@/lib/qs";

export const dynamic = "force-dynamic";
// Publishing is slow work (a parent create + one call per size + media
// sideload, per product), and the client sends it in batches through a server
// action hosted by this page — which inherits this page's limit.
export const maxDuration = 300;

/** Filter state lives in the URL, so the server can answer it. */
interface Search {
  q?: string;
  src?: string;
  onStore?: string;
}

const LENSES: PublishSourceLens[] = ["all", "goldensneakers", "kicksdb"];

/**
 * The Publish tab — the catalog→store direction the app was missing.
 *
 * Every other write path adjusts products the store already has; a supplier
 * feed brings genuinely new ones, which until now reached the catalog and
 * stopped there. This lists exactly that delta and creates the selected
 * products on WooCommerce: parent, canonical EU sizes, prices from the margin
 * rules, real feed stock, media.
 */
export default async function PublishPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { t } = await getServerDictionary();
  const sp = await searchParams;
  const params: QueryParams = { q: sp.q, src: sp.src, onStore: sp.onStore };
  const query = {
    q: sp.q,
    source: LENSES.find((l) => l === sp.src) ?? "all",
    showOnStore: sp.onStore === "1",
  };

  let state: PublishPageState;
  try {
    await assertSchemaCurrent();
    state = await getPublishState(query);
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
        counts={state.counts}
        matched={state.matched}
        params={params}
        hasSnapshot={state.hasSnapshot}
        wooConfigured={state.wooConfigured}
        siteUrl={wooSiteUrl()}
      />
    </main>
  );
}
