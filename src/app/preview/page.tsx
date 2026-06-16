import { PreviewWorkspace } from "@/components/preview/PreviewWorkspace";
import { getActiveConfig } from "@/server/config/repo";

export const dynamic = "force-dynamic";

export default async function PreviewPage() {
  const config = await getActiveConfig();

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Fetch &amp; preview</h1>
      <p className="mt-1 mb-6 text-sm text-neutral-600">
        Pull StockX prices via KicksDB, resolve known mappings, and preview the per-variant plan.
        Nothing is written to the store.
      </p>
      <PreviewWorkspace defaultMarket={config.source.market} />
    </main>
  );
}
