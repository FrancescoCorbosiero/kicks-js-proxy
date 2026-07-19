import { ImportWorkspace } from "@/components/import/ImportWorkspace";
import { getActiveConfig } from "@/server/config/repo";
import { listIngestionRuns } from "@/server/ingestion/repo";
import { getServerDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The Import tab: manual entry and bulk file entry into the catalog. Both are
 * frontends over the same verify-then-upsert pipeline the previews use.
 */
export default async function ImportPage() {
  const { t } = await getServerDictionary();
  const config = await getActiveConfig();
  const history = await listIngestionRuns();

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-7 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.importPage.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.importPage.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.importPage.desc}</p>
      </div>
      <ImportWorkspace defaultMarket={config.source.market} initialHistory={history} />
    </main>
  );
}
