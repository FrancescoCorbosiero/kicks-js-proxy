/**
 * Read the rows out of a raw `db.execute()` result.
 *
 * Drizzle's node-postgres driver hands back pg's QueryResult — an OBJECT with
 * a `rows` array, not an array. Code that assumed an array and guarded with
 * `Array.isArray(res) ? ... : fallback` therefore took the fallback every
 * single time: the query ran, the rows came back, and the caller quietly
 * returned "nothing". A count that is always zero looks exactly like a count
 * that is legitimately zero, which is why it survived.
 *
 * Kept driver-agnostic (some drivers really do return an array) so this stays
 * correct if the client changes, and shared so the mistake has one home.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** First column of the first row as an integer — the shape of a count query. */
export function countOf(result: unknown, key = "n"): number {
  const first = rowsOf<Record<string, unknown>>(result)[0];
  const raw = first?.[key];
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const parsed = Number.parseInt(String(raw ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
