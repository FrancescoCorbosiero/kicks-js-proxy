"use client";

import { useI18n } from "@/i18n/provider";
import type { CollectionPreview, PreviewProduct } from "@core/collections";

/**
 * "What saving does": how many products the category holds now and after,
 * who joins, who leaves — named, a few each — and the consequences worth a
 * word before they happen. Shared by the Hub's page and the Vetrina's sheet.
 */

export interface PreviewLook {
  frame: string;
  title: string;
  numbers: string;
  listTitle: string;
  item: string;
  note: string;
  warn: string;
}

export function RulePreview({
  preview,
  checking,
  error,
  indexProducts,
  isNew,
  look,
}: {
  preview: CollectionPreview | null;
  checking: boolean;
  error: string | null;
  /** Products the store index holds: none means nothing can be previewed yet. */
  indexProducts: number;
  /** A rule not saved before: hand-placed products leaving is news. */
  isNew: boolean;
  look: PreviewLook;
}) {
  const { t } = useI18n();
  const e = t.collections.editor;
  return (
    <section className={`@container ${look.frame}`} aria-live="polite">
      <div className="flex items-center gap-2">
        <span className={look.title}>{e.preview}</span>
        {checking && <span className={look.note}>{e.working}</span>}
      </div>
      {indexProducts === 0 ? (
        <p className={look.note}>{e.indexEmpty}</p>
      ) : error ? (
        <p className={look.warn}>
          {e.previewFailed} {error}
        </p>
      ) : preview ? (
        <PreviewBody preview={preview} isNew={isNew} look={look} />
      ) : null}
    </section>
  );
}

function PreviewBody({ preview: p, isNew, look }: { preview: CollectionPreview; isNew: boolean; look: PreviewLook }) {
  const { t } = useI18n();
  const e = t.collections.editor;
  const unchanged = p.joiningCount === 0 && p.leavingCount === 0;
  return (
    <div className="space-y-3">
      <p className={look.numbers}>
        {e.now} {p.before} → {e.after} {p.after}
        {!unchanged && (
          <>
            {" · "}
            <span className="text-create">
              {e.joining} {p.joiningCount}
            </span>
            {" · "}
            <span className="text-skip">
              {e.leaving} {p.leavingCount}
            </span>
          </>
        )}
      </p>
      {unchanged && <p className={look.note}>{e.unchanged}</p>}
      {p.after === 0 && p.before > 0 && <p className={look.warn}>{e.emptyAfter}</p>}
      {p.orphaned > 0 && <p className={look.warn}>{e.orphaned(p.orphaned)}</p>}
      {isNew && p.leavingCount > 0 && <p className={look.note}>{e.handPicked}</p>}
      <div className="grid gap-3 @2xl:grid-cols-3">
        {p.joiningCount > 0 && <Names title={e.joiningList} items={p.joining} total={p.joiningCount} look={look} />}
        {p.leavingCount > 0 && <Names title={e.leavingList} items={p.leaving} total={p.leavingCount} look={look} />}
        {p.after > 0 && <Names title={e.membersList} items={p.members} total={p.after} look={look} />}
      </div>
    </div>
  );
}

function Names({ title, items, total, look }: { title: string; items: PreviewProduct[]; total: number; look: PreviewLook }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <div className={look.listTitle}>
        {title} · {total}
      </div>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li key={item.id} className={look.item} title={item.sku}>
            {item.name || item.sku || `#${item.id}`}
          </li>
        ))}
      </ul>
      {total > items.length && <p className={look.note}>{t.collections.editor.more(total - items.length)}</p>}
    </div>
  );
}
