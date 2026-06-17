"use client";

import * as React from "react";
import { uploadStoreSnapshot } from "@/server/actions/store";
import type { SnapshotInfo } from "@/server/store-json/repo";
import { Button } from "@/components/ui/button";

export function StoreSnapshotPanel({ initialInfo }: { initialInfo: SnapshotInfo | null }) {
  const [info, setInfo] = React.useState<SnapshotInfo | null>(initialInfo);
  const [text, setText] = React.useState("");
  const [open, setOpen] = React.useState(!initialInfo);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setText);
  }

  function load() {
    setError(null);
    start(async () => {
      const res = await uploadStoreSnapshot(text);
      if (!res.ok) {
        setError(res.error ?? "Upload failed");
        return;
      }
      setInfo(res.info ?? null);
      setOpen(false);
      setText("");
    });
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="font-semibold">Store snapshot</span>
          {info ? (
            <span className="ml-2 text-neutral-500">
              {info.productCount} products · {info.siteUrl ?? "—"} · loaded{" "}
              {new Date(info.uploadedAt).toLocaleString()}
            </span>
          ) : (
            <span className="ml-2 text-amber-700">none loaded — preview can&apos;t match the store yet</span>
          )}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : info ? "Replace" : "Load"}
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <input type="file" accept="application/json,.json" onChange={onFile} className="text-sm" />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Paste the WooCommerce round-trip JSON (format "rp_cm_roundtrip")…'
            className="h-32 w-full rounded-md border border-neutral-300 p-2 font-mono text-xs"
          />
          <div className="flex items-center gap-3">
            <Button type="button" onClick={load} disabled={pending || text.trim().length === 0}>
              {pending ? "Loading…" : "Load store JSON"}
            </Button>
            {error && <span className="text-sm text-rose-600">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
