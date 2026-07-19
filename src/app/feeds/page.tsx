import { FeedsWorkspace } from "@/components/feeds/FeedsWorkspace";
import { DbUnavailable } from "@/components/DbUnavailable";
import { getFeedsState } from "@/server/actions/feeds";
import { getServerDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The Feeds tab: the ingestion-source registry. One built-in feed today (the
 * KicksDB staleness refresh); external supplier feeds plug in beside it, all
 * flowing through the same verify-then-upsert pipeline and ingestion_runs log.
 */
export default async function FeedsPage() {
  const { t } = await getServerDictionary();

  let state;
  try {
    state = await getFeedsState();
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-7 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.feeds.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.feeds.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.feeds.desc}</p>
      </div>
      <FeedsWorkspace initialState={state} />
    </main>
  );
}
