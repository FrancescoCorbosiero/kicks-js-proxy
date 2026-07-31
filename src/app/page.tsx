import Link from "next/link";
import { getServerDictionary } from "@/i18n/server";
import type { Dictionary } from "@/i18n/dictionary";
import { loadDashboardData, type ActivityItem, type DashboardData } from "@/server/dashboard/data";
import { DbUnavailable } from "@/components/DbUnavailable";

export const dynamic = "force-dynamic";

/**
 * The homepage IS the dashboard: what's in the catalog, how fresh the store
 * is, what happened recently — and one big button per next step. Written for
 * an operator who never wants to learn the machinery underneath.
 */
export default async function Home() {
  const { t } = await getServerDictionary();

  let data: DashboardData;
  try {
    data = await loadDashboardData();
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  const d = t.dashboard;
  const lastApply = data.lastApply;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 animate-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">{d.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{d.desc}</p>
      </div>

      {/* Attention banners — only when something needs the operator. */}
      <div className="space-y-3">
        {!data.wooConfigured && (
          <div className="rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-ink">
            {d.wooNotConfigured}
          </div>
        )}
        {data.runningPull && (
          <Link
            href="/sync"
            className="block rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm text-ink transition-colors hover:bg-info/15"
          >
            {d.pullRunning(
              data.runningPull.totalProducts != null
                ? `${data.runningPull.productsFetched}/${data.runningPull.totalProducts}`
                : String(data.runningPull.productsFetched),
            )}{" "}
            →
          </Link>
        )}
      </div>

      {/* The three things the operator actually does, as big cards. */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 stagger">
        <ActionCard
          href="/sync"
          primary
          title={d.syncCardTitle}
          desc={d.syncCardDesc}
          cta={d.syncCardCta}
          lines={[
            lastApply
              ? `${d.lastSync(timeAgo(lastApply.finishedAt ?? lastApply.startedAt, t))} · ${d.act.applyLine(lastApply.updatedCount)}`
              : d.lastSyncNever,
            data.snapshot
              ? `${d.statStoreLine(data.snapshot.productCount)} · ${d.snapshotUpdated(timeAgo(data.snapshot.uploadedAt, t))}`
              : d.statStoreNever,
          ]}
        />
        <ActionCard
          href="/catalog"
          title={d.catalogCardTitle}
          desc={d.catalogCardDesc}
          cta={d.catalogCardCta}
          lines={[
            `${data.catalog.total} ${d.statCatalog.toLowerCase()}`,
            `${data.catalog.kicksdb} ${d.statKicksdb} · ${data.catalog.goldensneakers} ${d.statGs}`,
          ]}
        />
        <ActionCard
          href="/import"
          title={d.importCardTitle}
          desc={d.importCardDesc}
          cta={d.importCardCta}
          lines={[
            data.gsConfigured || data.feed.activeSkus > 0
              ? `${d.statFeed}: ${d.statFeedLine(data.feed.activeSkus, data.feed.activeRows)}`
              : "",
          ].filter(Boolean)}
        />
      </div>

      {/* Freshness tile + activity, side by side on desktop. */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            {d.statStale}
          </div>
          {data.staleCount > 0 ? (
            <>
              <div className="mt-1 text-3xl font-bold tracking-tight tnum">{data.staleCount}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{d.statStaleHint}</p>
              <Link
                href="/feeds"
                className="mt-3 inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg transition-transform hover:scale-[1.02] active:scale-[0.98]"
              >
                {d.statStaleCta} →
              </Link>
            </>
          ) : (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <span className="h-2 w-2 rounded-full bg-down" />
              {d.statStaleOk}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            {d.activityTitle}
          </div>
          {data.activity.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{d.activityEmpty}</p>
          ) : (
            <ul className="mt-2 divide-y divide-line/60">
              {data.activity.map((item) => (
                <ActivityRow key={activityKey(item)} item={item} t={t} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

function ActionCard({
  href,
  title,
  desc,
  cta,
  lines,
  primary,
}: {
  href: string;
  title: string;
  desc: string;
  cta: string;
  lines: string[];
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group flex flex-col rounded-xl border p-4 shadow-xs transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:shadow-md ${
        primary ? "border-accent/40 bg-accent/8" : "border-line bg-surface hover:border-line-strong"
      }`}
    >
      <div className="text-base font-bold tracking-tight">{title}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{desc}</p>
      {lines.length > 0 && (
        <div className="mt-3 space-y-1 text-xs text-muted tnum">
          {lines.map((line) => (
            <div key={line} className="truncate" title={line}>
              {line}
            </div>
          ))}
        </div>
      )}
      <span
        className={`mt-auto inline-flex items-center gap-1.5 pt-4 text-sm font-semibold ${
          primary ? "text-accent-text" : "text-ink"
        }`}
      >
        {cta}
        <span className="transition-transform group-hover:translate-x-0.5">→</span>
      </span>
    </Link>
  );
}

function ActivityRow({ item, t }: { item: ActivityItem; t: Dictionary }) {
  const d = t.dashboard;
  let label: string;
  let detail: string;
  let dotClass = "bg-noop";

  if (item.kind === "apply") {
    label = item.run.dryRun ? d.act.dryRun : d.act.applied;
    detail = d.act.applyLine(item.run.updatedCount);
    dotClass =
      item.run.status === "failed"
        ? "bg-skip"
        : item.run.status === "partial"
          ? "bg-update"
          : item.run.dryRun
            ? "bg-info"
            : "bg-down";
  } else {
    const source = item.run.source;
    label =
      source === "manual"
        ? d.act.manual
        : source === "file"
          ? d.act.file
          : source === "feed:kicksdb"
            ? d.act.kicksdbRefresh
            : source === "feed:goldensneakers"
              ? d.act.gsSync
              : d.act.preview;
    detail = t.importPage.historyLine(item.run.added, item.run.known, item.run.rejected);
    dotClass = item.run.error ? "bg-skip" : "bg-down";
  }

  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span className="shrink-0 text-xs text-muted tnum">{detail}</span>
      <span className="w-20 shrink-0 text-right text-xs text-faint">{timeAgo(item.at, t)}</span>
    </li>
  );
}

function activityKey(item: ActivityItem): string {
  return `${item.kind}:${item.run.id}`;
}

function timeAgo(iso: string, t: Dictionary): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t.dashboard.ago.now;
  if (minutes < 60) return t.dashboard.ago.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.dashboard.ago.hours(hours);
  return t.dashboard.ago.days(Math.floor(hours / 24));
}
