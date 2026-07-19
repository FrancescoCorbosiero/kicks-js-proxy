import { SyncWorkspace } from "@/components/sync/SyncWorkspace";
import { DbUnavailable } from "@/components/DbUnavailable";
import { assertSchemaCurrent } from "@/server/db/probe";
import { getActiveConfig } from "@/server/config/repo";
import { getSnapshotInfo } from "@/server/store-json/repo";
import { getSyncState } from "@/server/actions/sync";
import { getServerDictionary } from "@/i18n/server";
import { parseSkus } from "@/lib/skus";

export const dynamic = "force-dynamic";

/**
 * The Woo sync tab — the main workflow: pull live store state over REST,
 * preview the per-variant repricing plan against the catalog prices, then
 * apply the selected changes back to the store (dry-run first).
 */
export default async function SyncPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const { t } = await getServerDictionary();

  let config, snapshotInfo, syncState;
  try {
    await assertSchemaCurrent();
    config = await getActiveConfig();
    snapshotInfo = await getSnapshotInfo().catch(() => null);
    syncState = await getSyncState();
  } catch (e) {
    return <DbUnavailable error={e} />;
  }
  const seedSkus = sp.skus ? parseSkus(sp.skus) : [];

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-7 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.sync.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.sync.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.sync.desc}</p>
      </div>
      <SyncWorkspace
        defaultMarket={config.source.market}
        snapshotInfo={snapshotInfo}
        initialState={syncState}
        seedSkus={seedSkus}
      />
    </main>
  );
}
