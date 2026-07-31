"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { trashDuplicateStoreProduct } from "@/server/actions/duplicates";
import type { DuplicateGroup, DupEntry, DupProduct } from "@/server/store-json/duplicates";

/**
 * Interactive side of the duplicates report. Removal is always the WordPress
 * TRASH (recoverable), one product per call, re-validated server-side; the
 * bulk button just walks the safe list sequentially with visible progress.
 */
export function DuplicatesWorkspace({
  groups: initialGroups,
  hasSnapshot,
  siteUrl,
  canDelete,
}: {
  groups: DuplicateGroup[];
  hasSnapshot: boolean;
  siteUrl: string | null;
  canDelete: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [groups, setGroups] = React.useState(initialGroups);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [armed, setArmed] = React.useState(false);
  const [bulk, setBulk] = React.useState<{ done: number; total: number } | null>(null);
  const [bulkOutcome, setBulkOutcome] = React.useState<{ ok: number; ko: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const safeCount = groups.reduce((n, g) => n + g.duplicates.filter((d) => d.safe).length, 0);

  function removeLocally(productId: number) {
    setGroups((gs) =>
      gs
        .map((g) => ({ ...g, duplicates: g.duplicates.filter((d) => d.id !== productId) }))
        .filter((g) => g.duplicates.length > 0),
    );
  }

  async function trashOne(productId: number): Promise<boolean> {
    const res = await trashDuplicateStoreProduct({ productId });
    if (res.ok) {
      removeLocally(productId);
      return true;
    }
    setError(res.error ?? t.duplicates.failed);
    return false;
  }

  function onTrashClick(productId: number) {
    setError(null);
    setBusyId(productId);
    void trashOne(productId).finally(() => {
      setBusyId(null);
      router.refresh();
    });
  }

  function onBulkClick() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setError(null);
    setBulkOutcome(null);
    const ids = groups.flatMap((g) => g.duplicates.filter((d) => d.safe).map((d) => d.id));
    setBulk({ done: 0, total: ids.length });
    void (async () => {
      let ok = 0;
      let ko = 0;
      for (const id of ids) {
        if (await trashOne(id)) ok += 1;
        else ko += 1;
        setBulk({ done: ok + ko, total: ids.length });
      }
      setBulk(null);
      setBulkOutcome({ ok, ko });
      router.refresh();
    })();
  }

  if (!hasSnapshot) {
    return (
      <div className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">
        {t.duplicates.noSnapshot}{" "}
        <Link href="/sync" className="font-semibold text-accent-text underline-offset-2 hover:underline">
          {t.header.navSync} →
        </Link>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface p-6">
        <p className="flex items-center gap-2 text-sm text-muted">
          <span className="h-2 w-2 rounded-full bg-down" />
          {bulkOutcome ? t.duplicates.bulkDone(bulkOutcome.ok) : t.duplicates.empty}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Bulk bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {t.duplicates.groups(groups.length)} · {t.duplicates.bulkTitle(safeCount)}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{t.duplicates.bulkHint}</p>
        </div>
        {canDelete ? (
          bulk ? (
            <span className="flex items-center gap-2 text-sm text-muted tnum">
              <span className="spin h-4 w-4 rounded-full border-2 border-line-strong border-t-accent-strong" />
              {t.duplicates.bulkProgress(bulk.done, bulk.total)}
            </span>
          ) : (
            safeCount > 0 && (
              <Button
                type="button"
                variant={armed ? "accent" : "outline"}
                onClick={onBulkClick}
                onBlur={() => setArmed(false)}
              >
                {armed ? t.duplicates.bulkConfirm : t.duplicates.bulkStart(safeCount)}
              </Button>
            )
          )
        ) : (
          <span className="text-xs text-muted">{t.duplicates.notConfigured}</span>
        )}
      </div>

      {bulkOutcome && bulkOutcome.ko > 0 && (
        <p className="text-sm text-skip">{t.duplicates.bulkErrors(bulkOutcome.ko)}</p>
      )}
      {error && <p className="text-sm text-skip">{error}</p>}

      {groups.map((g) => (
        <div key={g.sku} className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="border-b border-line bg-surface-2 px-4 py-2 font-mono text-xs font-semibold">
            {g.sku}
          </div>
          <ul className="divide-y divide-line/60">
            <ProductRow
              product={g.keeper}
              badge={t.duplicates.keeperBadge}
              badgeClass="bg-down/12 text-down"
              siteUrl={siteUrl}
            />
            {g.duplicates.map((d) => (
              <DuplicateRow
                key={d.id}
                entry={d}
                siteUrl={siteUrl}
                canDelete={canDelete}
                busy={busyId === d.id || bulk != null}
                onTrash={() => onTrashClick(d.id)}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ProductMeta({ product }: { product: DupProduct }) {
  const { t } = useI18n();
  return (
    <span className="text-xs text-muted tnum">
      {t.duplicates.meta(product.id, product.sizes.length, product.totalStock)}
    </span>
  );
}

function WooLink({ siteUrl, productId }: { siteUrl: string | null; productId: number }) {
  const { t } = useI18n();
  if (!siteUrl) return null;
  return (
    <a
      href={`${siteUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${productId}&action=edit`}
      target="_blank"
      rel="noreferrer"
      className="text-xs font-medium text-faint underline-offset-2 hover:text-ink hover:underline"
    >
      {t.duplicates.openInWoo} ↗
    </a>
  );
}

function ProductRow({
  product,
  badge,
  badgeClass,
  siteUrl,
}: {
  product: DupProduct;
  badge: string;
  badgeClass: string;
  siteUrl: string | null;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${badgeClass}`}>
        {badge}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">
        {product.name || t.duplicates.unnamed}
      </span>
      <ProductMeta product={product} />
      <WooLink siteUrl={siteUrl} productId={product.id} />
    </li>
  );
}

function DuplicateRow({
  entry,
  siteUrl,
  canDelete,
  busy,
  onTrash,
}: {
  entry: DupEntry;
  siteUrl: string | null;
  canDelete: boolean;
  busy: boolean;
  onTrash: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold tracking-wide text-muted">
        {t.duplicates.dupBadge}
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.name || t.duplicates.unnamed}</span>
      <ProductMeta product={entry} />
      <WooLink siteUrl={siteUrl} productId={entry.id} />
      {entry.safe ? (
        canDelete && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            title={t.duplicates.safeHint}
            disabled={busy}
            onClick={onTrash}
          >
            {busy ? t.duplicates.trashing : t.duplicates.trash}
          </Button>
        )
      ) : (
        <span className="w-full text-xs text-update sm:w-auto sm:max-w-64">
          {t.duplicates.unsafe(entry.missingSizes.join(", "))}
        </span>
      )}
    </li>
  );
}
