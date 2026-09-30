import { getServerDictionary } from "@/i18n/server";
import { assertSchemaCurrent } from "@/server/db/probe";
import { DbUnavailable } from "@/components/DbUnavailable";
import { getActiveSnapshot, getSnapshotInfo } from "@/server/store-json/repo";
import { findDuplicateGroups, type DuplicateGroup } from "@/server/store-json/duplicates";
import { wooConfigured } from "@/server/woo/client";
import { DuplicatesWorkspace } from "@/components/duplicates/DuplicatesWorkspace";

export const dynamic = "force-dynamic";

/**
 * The duplicate-products report: store products sharing one SKU, with the
 * redundant copies removable (WordPress trash — always recoverable). Reached
 * from the dashboard banner; deliberately not a main nav tab.
 */
export default async function DuplicatesPage() {
  const { t } = await getServerDictionary();

  let groups: DuplicateGroup[] = [];
  let hasSnapshot = false;
  let siteUrl: string | null = null;
  try {
    await assertSchemaCurrent();
    const [snapshot, info] = await Promise.all([
      getActiveSnapshot(),
      getSnapshotInfo().catch(() => null),
    ]);
    hasSnapshot = snapshot != null;
    siteUrl = info?.siteUrl ?? null;
    if (snapshot) groups = findDuplicateGroups(snapshot);
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.duplicates.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.duplicates.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.duplicates.desc}</p>
      </div>

      <DuplicatesWorkspace
        groups={groups}
        hasSnapshot={hasSnapshot}
        siteUrl={siteUrl}
        canDelete={wooConfigured()}
      />
    </main>
  );
}
