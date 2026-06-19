import { PreviewWorkspace } from "@/components/preview/PreviewWorkspace";
import { getActiveConfig } from "@/server/config/repo";
import { pricingSummary } from "@/server/config/summary";
import { getSnapshotInfo } from "@/server/store-json/repo";

export const dynamic = "force-dynamic";

export default async function PreviewPage() {
  const config = await getActiveConfig();
  const pricing = pricingSummary(config);
  const snapshotInfo = await getSnapshotInfo().catch(() => null);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-7 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>Workspace</span>
          <span>/</span>
          <span className="text-muted">Preview</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Fetch &amp; preview</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
          Pull StockX prices via KicksDB, resolve known mappings by EU size, and preview the
          per-variant plan. Nothing is written to the store — you export a re-import file.
        </p>
      </div>
      <PreviewWorkspace
        defaultMarket={config.source.market}
        snapshotInfo={snapshotInfo}
        pricing={pricing}
      />
    </main>
  );
}
