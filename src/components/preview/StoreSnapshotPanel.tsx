"use client";

import * as React from "react";
import { uploadStoreSnapshot } from "@/server/actions/store";
import type { SnapshotInfo } from "@/server/store-json/repo";
import { Button } from "@/components/ui/button";

export function StoreSnapshotPanel({
  initialInfo,
  onLoaded,
}: {
  initialInfo: SnapshotInfo | null;
  onLoaded?: (info: SnapshotInfo) => void;
}) {
  const [info, setInfo] = React.useState<SnapshotInfo | null>(initialInfo);
  const [open, setOpen] = React.useState(!initialInfo);
  const [error, setError] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [pending, start] = React.useTransition();
  const inputRef = React.useRef<HTMLInputElement>(null);

  function loadText(content: string, name: string | null) {
    setError(null);
    start(async () => {
      const res = await uploadStoreSnapshot(content);
      if (!res.ok) {
        setError(res.error ?? "Upload failed");
        return;
      }
      setInfo(res.info ?? null);
      setFileName(name);
      setOpen(false);
      setPasteOpen(false);
      setText("");
      if (res.info) onLoaded?.(res.info);
    });
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    file
      .text()
      .then((t) => loadText(t, file.name))
      .catch(() => setError("Could not read the file."));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="font-semibold">Store snapshot</span>
          {info ? (
            <span className="ml-2 text-neutral-500">
              {info.productCount} products · {info.siteUrl ?? "—"}
              {fileName ? ` · ${fileName}` : ""} · loaded {new Date(info.uploadedAt).toLocaleString()}
            </span>
          ) : (
            <span className="ml-2 text-amber-700">
              none loaded — preview can&apos;t match the store yet
            </span>
          )}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : info ? "Replace" : "Load"}
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? undefined)}
          />

          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
              dragging ? "border-neutral-900 bg-neutral-50" : "border-neutral-300 hover:bg-neutral-50"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7 text-neutral-400">
              <path d="M12 16V4m0 0L8 8m4-4 4 4" />
              <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <div className="text-sm font-medium">
              {pending ? "Loading…" : "Drag your store JSON here, or click to browse"}
            </div>
            <div className="text-xs text-neutral-400">WooCommerce round-trip file (.json)</div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPasteOpen((p) => !p)}
              className="text-xs text-neutral-500 underline-offset-2 hover:underline"
            >
              {pasteOpen ? "Hide paste box" : "or paste JSON instead"}
            </button>
            {error && <span className="text-sm text-rose-600">{error}</span>}
          </div>

          {pasteOpen && (
            <div className="space-y-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder='Paste the WooCommerce round-trip JSON (format "rp_cm_roundtrip")…'
                className="h-32 w-full rounded-md border border-neutral-300 p-2 font-mono text-xs"
              />
              <Button
                type="button"
                onClick={() => loadText(text, "pasted")}
                disabled={pending || text.trim().length === 0}
              >
                {pending ? "Loading…" : "Load pasted JSON"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
