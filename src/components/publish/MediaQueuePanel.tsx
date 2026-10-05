"use client";

import * as React from "react";
import { getPhotoQueue, resolveFailedPhotos } from "@/server/actions/publish";
import type { MediaQueueState } from "@/server/woo/media";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** How often the counts are read again while photos are on their way. */
const POLL_MS = 20_000;
/** Failed rows rendered; the badge counts them all. */
const ROW_LIMIT = 20;

/**
 * The photo queue, seen from the Publish tab: products created hidden and
 * waiting for their first photo, galleries still filling in, and the jobs that
 * stopped — a photo the store refused, a product with none — with a way to
 * try them again or take them off the list. Absent when there is nothing to say.
 */
export function MediaQueuePanel({
  initial,
  worker,
  siteUrl,
}: {
  initial: MediaQueueState;
  /** Something works the queue (the in-app scheduler is on). */
  worker: boolean;
  siteUrl: string;
}) {
  const { t } = useI18n();
  const m = t.publish.media;
  // What a poll or an action read last — until the page hands over fresh
  // counts (a run just filed more), which win again.
  const [newer, setNewer] = React.useState<{ base: MediaQueueState; state: MediaQueueState } | null>(null);
  const state = newer?.base === initial ? newer.state : initial;
  const [busy, setBusy] = React.useState<"retry" | "dismiss" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const pending = state.hidden + state.photos;
  React.useEffect(() => {
    if (pending === 0) return;
    const timer = setInterval(async () => {
      const res = await getPhotoQueue().catch(() => null);
      if (res?.ok) setNewer({ base: initial, state: res.media });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, initial]);

  if (pending === 0 && state.failedTotal === 0) return null;

  async function resolve(action: "retry" | "dismiss") {
    setBusy(action);
    setError(null);
    try {
      const res = await resolveFailedPhotos({ action });
      if (res.ok) setNewer({ base: initial, state: res.media });
      else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  const editUrl = (id: number) => `${siteUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${id}&action=edit`;

  return (
    <section className="space-y-2 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{m.title}</span>
        {state.hidden > 0 && (
          <Badge variant="warn" title={m.hiddenHint}>
            {m.hidden(state.hidden)}
          </Badge>
        )}
        {state.photos > 0 && <Badge variant="update">{m.photos(state.photos)}</Badge>}
        {state.failedTotal > 0 && <Badge variant="skip">{m.failed(state.failedTotal)}</Badge>}
      </div>
      <p className="text-xs leading-snug text-muted">{m.desc}</p>
      {!worker && pending > 0 && <p className="text-xs leading-snug font-medium text-warn">{m.noWorker}</p>}

      {state.failed.length > 0 && (
        <>
          <ul className="space-y-1">
            {state.failed.slice(0, ROW_LIMIT).map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line/60 pt-1 text-[11px] first:border-0 first:pt-0"
              >
                <span className="font-mono text-faint">{job.sku}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{job.title}</span>
                <span className="text-faint tnum">{m.progress(job.attached, job.total)}</span>
                {job.error && <span className="text-skip">{job.error}</span>}
                {job.storeProductId != null && siteUrl && (
                  <a
                    href={editUrl(job.storeProductId)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-accent-text underline-offset-2 hover:underline"
                  >
                    {m.open} →
                  </a>
                )}
              </li>
            ))}
          </ul>
          {state.failedTotal > ROW_LIMIT && (
            <p className="text-[11px] text-faint">{m.more(state.failedTotal - ROW_LIMIT)}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void resolve("retry")}>
              {busy === "retry" ? m.retrying : m.retry}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => void resolve("dismiss")}>
              {m.dismiss}
            </Button>
            <span className="text-[11px] text-faint">{m.retryHint}</span>
          </div>
        </>
      )}
      {error && <p className="text-xs text-skip">{error}</p>}
    </section>
  );
}
