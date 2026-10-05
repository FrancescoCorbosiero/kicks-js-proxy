"use client";

import * as React from "react";
import { Button, Preloader } from "konsta/react";
import { toast } from "sonner";
import { useI18n } from "@/i18n/provider";
import type { ProductTagsView } from "@/lib/collections/types";
import { loadProductTags, saveProductTags } from "@/server/actions/collections";
import { Close } from "./icons";

/**
 * A product's tags, in its sheet: the convenient way to move it in and out
 * of the automatic categories without leaving the phone. The tags are saved
 * on the store, the product is decided at once, and the sheet says which
 * sections it joined or left.
 */

type Chip = { id?: number; name: string };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const signature = (chips: Chip[]) =>
  chips
    .map((c) => c.name.trim().toLowerCase())
    .sort()
    .join("\n");

export function TagsSection({ productId, onChanged }: { productId: number; onChanged: () => void }) {
  const { t } = useI18n();
  const tg = t.vetrina.tags;
  const [view, setView] = React.useState<ProductTagsView | null | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [chips, setChips] = React.useState<Chip[]>([]);
  const [typed, setTyped] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const listId = React.useId();

  const load = React.useCallback(async () => {
    setView(undefined);
    setError(null);
    const res = await loadProductTags({ productId });
    if (!res.ok) {
      setError(res.error);
      setView(null);
      return;
    }
    setView(res.data);
    setChips(res.data.tags.map((x) => ({ id: x.id, name: x.name })));
  }, [productId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (view === undefined) {
    return (
      <div className="flex items-center gap-2 px-1 py-3 text-[14px] opacity-60">
        <Preloader className="!h-4 !w-4" />
        {tg.loading}
      </div>
    );
  }
  if (view === null) {
    return <p className="px-1 text-[13px] opacity-60">{error}</p>;
  }

  const dirty = signature(chips) !== signature(view.tags);

  function add() {
    const name = typed.trim();
    if (!name) return;
    setTyped("");
    if (chips.some((c) => sameName(c.name, name))) return;
    const known = view?.available.find((x) => sameName(x.name, name));
    setChips((prev) => [...prev, known ? { id: known.id, name: known.name } : { name }]);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await saveProductTags({ productId, tags: chips });
      if (!res.ok) {
        toast.error(`${tg.failed}: ${res.error}`);
        return;
      }
      const { joined, left, pending, error: refused } = res.data;
      if (refused) toast.error(tg.refused(refused));
      else if (pending) toast(tg.pending);
      else {
        const said = [joined.length ? tg.joined(joined.join(", ")) : "", left.length ? tg.left(left.join(", ")) : ""]
          .filter(Boolean)
          .join(" · ");
        toast.success(said || tg.saved);
      }
      await load();
      if (joined.length > 0 || left.length > 0 || pending) onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <span className="mb-1.5 block px-1 text-[13px] font-semibold uppercase tracking-wide opacity-50">{tg.title}</span>
      <div className="space-y-3 rounded-2xl bg-white p-3 dark:bg-black/40">
        {chips.length === 0 ? (
          <p className="text-[14px] opacity-50">{tg.none}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <li
                key={chip.name.toLowerCase()}
                className="inline-flex items-center gap-1 rounded-full bg-black/[0.06] py-1 pl-3 pr-1 text-[14px] dark:bg-white/15"
              >
                {chip.name}
                <button
                  type="button"
                  aria-label={tg.remove(chip.name)}
                  onClick={() => setChips((prev) => prev.filter((c) => c !== chip))}
                  className="grid h-6 w-6 place-items-center rounded-full opacity-50 active:opacity-30"
                >
                  <Close className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input
            list={listId}
            value={typed}
            placeholder={tg.placeholder}
            autoCapitalize="none"
            enterKeyHint="done"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            className="min-w-0 flex-1 rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2 text-[16px] outline-none placeholder:opacity-40 focus:border-black/30 dark:border-white/15 dark:bg-white/10"
          />
          <datalist id={listId}>
            {view.available
              .filter((x) => !chips.some((c) => sameName(c.name, x.name)))
              .map((x) => (
                <option key={x.id} value={x.name} />
              ))}
          </datalist>
          <Button small rounded tonal inline disabled={!typed.trim()} onClick={add}>
            {tg.add}
          </Button>
        </div>
        {view.inCollections.length > 0 && (
          <p className="text-[13px] opacity-60">{tg.inCollections(view.inCollections.join(", "))}</p>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[12px] opacity-50">{tg.hint}</p>
      {dirty && (
        <Button
          large
          rounded
          className="mt-3"
          disabled={saving}
          onClick={() => void save()}
          colors={{ fillTextIos: "text-white dark:text-black", fillTextMaterial: "text-white dark:text-black" }}
        >
          {saving ? tg.saving : tg.save}
        </Button>
      )}
    </div>
  );
}
