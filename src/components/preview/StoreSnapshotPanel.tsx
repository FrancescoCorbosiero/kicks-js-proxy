"use client";

import * as React from "react";
import { uploadStoreSnapshot } from "@/server/actions/store";
import type { SnapshotInfo } from "@/server/store-json/repo";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";

export function StoreSnapshotPanel({
  initialInfo,
  onLoaded,
}: {
  initialInfo: SnapshotInfo | null;
  onLoaded?: (info: SnapshotInfo) => void;
}) {
  const { t } = useI18n();
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
        setError(res.error ?? t.snapshot.uploadFailed);
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
      .then((content) => loadText(content, file.name))
      .catch(() => setError(t.snapshot.readError));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm">
          <span
            className={cn(
              "grid h-9 w-9 place-items-center rounded-lg border",
              info ? "border-down/25 bg-down/12 text-down" : "border-warn/25 bg-warn/12 text-warn",
            )}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[18px] w-[18px]">
              <path d="M3 9h18M3 9l2-5h14l2 5M3 9v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9" />
            </svg>
          </span>
          <div>
            <div className="font-semibold">{t.snapshot.title}</div>
            {info ? (
              <div className="text-xs text-faint">
                {t.snapshot.info(
                  info.productCount,
                  info.siteUrl ?? "—",
                  fileName,
                  new Date(info.uploadedAt).toLocaleString(),
                )}
              </div>
            ) : (
              <div className="text-xs text-warn">{t.snapshot.none}</div>
            )}
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? t.snapshot.hide : info ? t.snapshot.replace : t.snapshot.load}
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-2 animate-fade-up">
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
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors",
              dragging
                ? "border-accent/60 bg-accent/[0.06]"
                : "border-line-strong hover:border-accent/40 hover:bg-surface-2",
            )}
          >
            <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-faint">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
                <path d="M12 16V4m0 0L8 8m4-4 4 4" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
            </span>
            <div className="text-sm font-medium">{pending ? t.snapshot.loading : t.snapshot.drop}</div>
            <div className="text-xs text-faint">{t.snapshot.dropHint}</div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPasteOpen((p) => !p)}
              className="text-xs text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {pasteOpen ? t.snapshot.pasteHide : t.snapshot.pasteShow}
            </button>
            {error && <span className="text-sm text-skip">{error}</span>}
          </div>

          {pasteOpen && (
            <div className="space-y-2 animate-fade-up">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t.snapshot.pastePlaceholder}
                className="h-32 w-full rounded-md border border-line bg-surface-2 p-2 font-mono text-xs text-ink transition-[border-color,box-shadow] placeholder:text-faint focus-visible:border-accent/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/15"
              />
              <Button
                type="button"
                onClick={() => loadText(text, "pasted")}
                disabled={pending || text.trim().length === 0}
              >
                {pending ? t.snapshot.loading : t.snapshot.loadPasted}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
