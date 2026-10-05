/**
 * How many products the Publish tab sends per request.
 *
 * Behind Cloudflare, a request still running after 100 seconds is answered
 * with a 524. How long a product takes depends on the shop — WooCommerce
 * downloads its photos and builds the thumbnails while creating it — so no
 * fixed size is right: 25 ran past the limit on a real shop, while 6 leaves
 * a fast shop idling between requests. The first batch is small, and every
 * next one is sized from the pace measured so far to take about
 * TARGET_BATCH_MS.
 */

export const FIRST_BATCH = 6;
export const MIN_BATCH = 3;
/** Ceiling, whatever the pace: a request that fails takes this many products' reports with it. */
export const MAX_BATCH = 25;
/** What one request should take: well inside Cloudflare's 100 seconds. */
export const TARGET_BATCH_MS = 45_000;
/** Growth per step: one quick batch (all skipped, say) is not yet a pace. */
const MAX_GROWTH = 1.5;

/**
 * Milliseconds per product, smoothed: half the previous estimate, half the
 * batch just measured — one slow photo does not halve the next batch.
 */
export function nextPace(previous: number | null, batchMs: number, products: number): number {
  const measured = batchMs / Math.max(1, products);
  return previous == null ? measured : (previous + measured) / 2;
}

/** The next batch's size at this pace (ms per product), from the current one. */
export function nextBatchSize(current: number, pace: number): number {
  const fits = Math.floor(TARGET_BATCH_MS / Math.max(1, pace));
  const grown = Math.ceil(current * MAX_GROWTH);
  return Math.max(MIN_BATCH, Math.min(MAX_BATCH, fits, grown));
}
