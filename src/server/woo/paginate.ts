/**
 * When to stop asking a remote endpoint for "the next page".
 *
 * A paging loop that only ends when the remote sends a short page has handed
 * the remote control of its own termination — and of the caller's memory, when
 * the caller accumulates. A WooCommerce install that ignores or clamps `page`
 * (a caching layer, a security plugin, a REST filter, a misconfigured proxy)
 * answers every page with the first one, and the loop collects the same rows
 * forever: RSS climbs until "Ineffective mark-compacts near heap limit" kills
 * the process mid-pull. Reproduced exactly that way before this existed.
 *
 * So the loop decides for itself, on two signals the remote cannot fake away:
 * rows it has already seen, and a hard ceiling on pages.
 */

/** Pages one resource may be asked for. 20 x 100 rows is already pathological. */
export const MAX_PAGES = 20;

export type PageVerdict =
  /** Short page: the remote is paginating and this was the last one. */
  | "complete"
  /** Repeats: the remote is NOT paginating. Keep what is distinct, stop. */
  | "not-paginating"
  /** Ceiling reached. Keep what we have, stop, and say so. */
  | "capped"
  | "continue";

export function pageVerdict(input: {
  /** 1-based page just fetched. */
  page: number;
  /** Rows the remote returned. */
  rows: number;
  /** Of those, how many were NOT already collected. */
  fresh: number;
  /** Rows per page requested. */
  perPage: number;
  maxPages?: number;
}): PageVerdict {
  const { page, rows, fresh, perPage, maxPages = MAX_PAGES } = input;
  // Checked FIRST: a non-paginating remote can also send a short page, and
  // repeats are the stronger signal — they mean the cursor never moved.
  if (rows > 0 && fresh < rows) return "not-paginating";
  if (rows < perPage) return "complete";
  if (page >= maxPages) return "capped";
  return "continue";
}
