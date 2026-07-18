"use client";

import * as React from "react";
import { getIngestionHistory, importSkus, type ImportResult } from "@/server/actions/import";
import type { IngestionHistoryEntry } from "@/server/ingestion/repo";
import { extractSkus } from "@/lib/skus";
import { chunkArray } from "@/lib/chunk";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** SKUs per action call — each brand-new SKU costs one KicksDB verification. */
const CHUNK = 50;

interface RunState {
  total: number;
  processed: number;
  added: number;
  known: number;
  rejected: string[];
  catalogTotal: number | null;
  error: string | null;
  done: boolean;
}

export function ImportWorkspace({
  defaultMarket,
  initialHistory,
}: {
  defaultMarket: string;
  initialHistory: IngestionHistoryEntry[];
}) {
  const { t } = useI18n();
  const [market, setMarket] = React.useState(defaultMarket);
  const [text, setText] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [fileSkus, setFileSkus] = React.useState<string[]>([]);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [run, setRun] = React.useState<RunState | null>(null);
  const [history, setHistory] = React.useState(initialHistory);

  const manualSkus = React.useMemo(() => extractSkus(text), [text]);

  async function onFile(file: File) {
    setFileError(null);
    setFileName(file.name);
    try {
      const content = await file.text();
      const skus = extractSkus(content);
      setFileSkus(skus);
      if (skus.length === 0) setFileError(t.importPage.fileEmpty);
    } catch {
      setFileSkus([]);
      setFileError(t.importPage.fileReadError);
    }
  }

  /** Chunked import: one ingestion run, N sequential verified chunks. */
  async function runImport(skus: string[], source: "manual" | "file") {
    if (skus.length === 0 || running) return;
    setRunning(true);
    const state: RunState = {
      total: skus.length,
      processed: 0,
      added: 0,
      known: 0,
      rejected: [],
      catalogTotal: null,
      error: null,
      done: false,
    };
    setRun({ ...state });

    try {
      let runId: string | undefined;
      for (const part of chunkArray(skus, CHUNK)) {
        const res: ImportResult = await importSkus({ skus: part, market, source, runId });
        if (!res.ok) {
          state.error = res.error ?? t.importPage.failed;
          break;
        }
        runId = res.runId ?? runId;
        state.processed += part.length;
        state.added += res.added ?? 0;
        state.known += res.known ?? 0;
        state.rejected.push(...(res.rejected ?? []));
        state.catalogTotal = res.total ?? state.catalogTotal;
        setRun({ ...state });
      }
      state.done = state.error == null;
      setRun({ ...state });
      setHistory(await getIngestionHistory());
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Manual entry */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{t.importPage.manualTitle}</div>
            <div className="text-xs text-muted">{t.importPage.manualDesc}</div>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="imp-market">{t.search.market}</Label>
              <Input
                id="imp-market"
                className="w-20"
                value={market}
                onChange={(e) => setMarket(e.target.value.toUpperCase())}
              />
            </div>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          <Textarea
            placeholder="CT8012-047, DZ5485-612, IE7002…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted tnum">{t.importPage.parsed(manualSkus.length)}</span>
            <Button
              type="button"
              variant="accent"
              className="ml-auto"
              disabled={manualSkus.length === 0 || running}
              onClick={() => runImport(manualSkus, "manual")}
            >
              {running ? t.importPage.importing : t.importPage.importButton(manualSkus.length)}
            </Button>
          </div>
        </div>
      </section>

      {/* Bulk file entry */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div className="text-sm font-semibold">{t.importPage.fileTitle}</div>
        <div className="text-xs text-muted">{t.importPage.fileDesc}</div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface-2 px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:text-ink">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
              <path d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16" />
            </svg>
            {fileName ?? t.importPage.filePick}
            <input
              type="file"
              accept=".csv,.txt,.tsv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {fileSkus.length > 0 && (
            <>
              <span className="text-xs text-muted tnum">{t.importPage.parsed(fileSkus.length)}</span>
              <Button
                type="button"
                variant="accent"
                disabled={running}
                onClick={() => runImport(fileSkus, "file")}
              >
                {running ? t.importPage.importing : t.importPage.importButton(fileSkus.length)}
              </Button>
            </>
          )}
        </div>
        {fileError && <p className="mt-2 text-sm text-skip">{fileError}</p>}
      </section>

      {/* Progress / report */}
      {run && (
        <section className="rounded-xl border border-line bg-surface p-4 shadow-xs animate-fade-up">
          <div className="flex items-center gap-3">
            {!run.done && !run.error && (
              <span className="spin h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent" />
            )}
            <span className="text-sm font-semibold tnum">
              {t.importPage.progress(run.processed, run.total)}
            </span>
            {run.catalogTotal != null && (
              <span className="ml-auto text-xs text-accent-text tnum">
                {t.results.catalogStats(run.catalogTotal, run.added)}
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${Math.round((run.processed / Math.max(1, run.total)) * 100)}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted tnum">
            <span className="text-up">{t.importPage.added(run.added)}</span>
            <span>{t.importPage.known(run.known)}</span>
            <span className={run.rejected.length > 0 ? "text-skip" : undefined}>
              {t.importPage.rejected(run.rejected.length)}
            </span>
          </div>
          {run.error && <p className="mt-2 text-sm text-skip">{run.error}</p>}
          {run.done && run.rejected.length > 0 && (
            <details className="mt-2 text-xs text-muted">
              <summary className="cursor-pointer font-medium">{t.importPage.rejectedList}</summary>
              <p className="mt-1 font-mono">{run.rejected.join(", ")}</p>
            </details>
          )}
        </section>
      )}

      {/* History */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div className="text-sm font-semibold">{t.importPage.historyTitle}</div>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t.importPage.historyEmpty}</p>
        ) : (
          <ul className="mt-2 divide-y divide-line/60 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="text-xs text-faint tnum">
                  {new Date(h.startedAt).toLocaleString()}
                </span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
                  {t.importPage.sources[h.source as "manual" | "file"] ?? h.source}
                </span>
                <span className="text-xs text-faint">{h.market}</span>
                <span className="ml-auto text-xs text-muted tnum">
                  {t.importPage.historyLine(h.added, h.known, h.rejected)}
                </span>
                {h.error && <span className="w-full text-xs text-skip">{h.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
