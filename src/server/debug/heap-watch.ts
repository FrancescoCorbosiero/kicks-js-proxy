import "server-only";

/**
 * Print the heap into the dev server's own console, next to the request log.
 *
 * The crash reports for this app are all the same shape: a heap pinned near
 * the 4 GB cap, a mark-compact that frees almost nothing, and — right above
 * it — an ordinary 30 ms request that cannot possibly have allocated it. The
 * request log names WHAT ran; it does not say what the heap did while it ran,
 * so the line that actually grew it is invisible.
 *
 * This prints one line per tick into the same console, so the growth lands
 * interleaved with the requests. The step that costs 900 MB is then the one
 * with the request lines above it, and there is nothing extra to run: whoever
 * is reproducing the crash is already looking at this console.
 *
 * Only what it can say cheaply, in a form that is readable at a glance:
 *   [heap]  +842MB   heap 1204MB / 1280MB   rss 1890MB   ext 12MB   up 214s
 *
 * ON in development, never in production, silenced with HEAP_WATCH=off. It
 * speaks only when the heap moves by 25 MB or more, so an ordinary session
 * prints almost nothing — and the one session that matters prints the answer
 * without anybody having to have switched it on beforehand.
 */

const MB = 1024 * 1024;
const mb = (n: number) => Math.round(n / MB);

/** Below this, a change is ordinary churn and not worth a line. */
const QUIET_DELTA_MB = 25;

let started = false;

export function startHeapWatch(): void {
  if (started) return;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.HEAP_WATCH === "off") return;
  started = true;

  const everyMs = Math.max(1000, Number(process.env.HEAP_WATCH_MS ?? 5000));
  let last = process.memoryUsage().heapUsed;
  let peak = last;

  console.log(
    `[heap] watching every ${Math.round(everyMs / 1000)}s — a line appears when the heap moves by ${QUIET_DELTA_MB} MB or more.`,
  );

  const timer = setInterval(() => {
    const m = process.memoryUsage();
    const deltaMb = Math.round((m.heapUsed - last) / MB);
    if (m.heapUsed > peak) peak = m.heapUsed;
    if (Math.abs(deltaMb) >= QUIET_DELTA_MB) {
      const sign = deltaMb > 0 ? "+" : "";
      console.log(
        `[heap] ${(sign + deltaMb + "MB").padStart(8)}   ` +
          `heap ${mb(m.heapUsed)}MB / ${mb(m.heapTotal)}MB   ` +
          `rss ${mb(m.rss)}MB   ext ${mb(m.external)}MB   ` +
          `peak ${mb(peak)}MB   up ${Math.round(process.uptime())}s`,
      );
      last = m.heapUsed;
    }
  }, everyMs);

  // Never hold the process open on its own account.
  timer.unref?.();
}
