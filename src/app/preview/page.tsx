import { PreviewWorkspace } from "@/components/preview/PreviewWorkspace";
import { getActiveConfig } from "@/server/config/repo";
import { pricingSummary } from "@/server/config/summary";
import { getSnapshotInfo } from "@/server/store-json/repo";
import { getOverrides } from "@/server/overrides/repo";
import { globalFollowSaleRule } from "@/server/overrides/model";
import { getServerDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

export default async function PreviewPage() {
  const { t } = await getServerDictionary();
  const config = await getActiveConfig();
  const pricing = pricingSummary(config);
  const snapshotInfo = await getSnapshotInfo().catch(() => null);
  const overrides = await getOverrides().catch(() => null);
  const followSaleRule = overrides ? globalFollowSaleRule(overrides) : true;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-7 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.preview.crumbPreview}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.preview.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.preview.desc}</p>
      </div>
      <PreviewWorkspace
        defaultMarket={config.source.market}
        snapshotInfo={snapshotInfo}
        pricing={pricing}
        initialFollowSaleRule={followSaleRule}
      />
    </main>
  );
}
