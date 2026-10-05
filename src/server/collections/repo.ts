import "server-only";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { HoldReason, IndexedProduct, SmartCollection } from "@core/collections";
import { db } from "@/server/db/client";
import { rowsOf } from "@/server/db/rows";
import {
  collectionChanges,
  smartCollections,
  storeIndex,
  type CollectionChangeRow,
  type SmartCollectionRow,
} from "@/server/db/schema";
import type { IndexRow } from "./index-rows";

/**
 * The automatic categories' tables: the rules (smart_collections), the store
 * as the rules read it (store_index), and the log of every product moved
 * (collection_changes).
 */

/* ---------------------------------------------------------------- *
 * Rules
 * ---------------------------------------------------------------- */

export function toCollection(row: SmartCollectionRow): SmartCollection {
  return {
    id: row.id,
    termId: row.termId,
    name: row.name,
    match: row.match,
    conditions: row.conditions,
    enabled: row.enabled,
  };
}

export async function listCollectionRows(): Promise<SmartCollectionRow[]> {
  return db.select().from(smartCollections).orderBy(smartCollections.createdAt);
}

export async function getCollectionRow(id: string): Promise<SmartCollectionRow | null> {
  const rows = await db.select().from(smartCollections).where(eq(smartCollections.id, id)).limit(1);
  return rows[0] ?? null;
}

export type CollectionInput = Pick<SmartCollection, "termId" | "name" | "match" | "conditions" | "enabled">;

export async function insertCollection(input: CollectionInput): Promise<SmartCollectionRow> {
  const [row] = await db.insert(smartCollections).values(input).returning();
  return row;
}

/** A changed rule starts over: whatever an older rule left on hold is not this one's to keep. */
export async function updateCollection(id: string, input: CollectionInput): Promise<SmartCollectionRow | null> {
  const [row] = await db
    .update(smartCollections)
    .set({ ...input, held: null, lastError: null, updatedAt: new Date() })
    .where(eq(smartCollections.id, id))
    .returning();
  return row ?? null;
}

export async function setCollectionEnabled(id: string, enabled: boolean): Promise<void> {
  await db
    .update(smartCollections)
    .set({ enabled, held: null, updatedAt: new Date() })
    .where(eq(smartCollections.id, id));
}

export async function deleteCollection(id: string): Promise<void> {
  await db.delete(smartCollections).where(eq(smartCollections.id, id));
}

/** What a run found for one collection. Undefined fields are left as they are. */
export interface CollectionReport {
  members?: number;
  held?: { reason: HoldReason; joining: number; leaving: number } | null;
  lastError?: string | null;
  lastRunAt?: Date;
}

export async function reportCollection(id: string, report: CollectionReport): Promise<void> {
  const set: Partial<typeof smartCollections.$inferInsert> = {};
  if (report.members !== undefined) set.members = report.members;
  if (report.held !== undefined) set.held = report.held;
  if (report.lastError !== undefined) set.lastError = report.lastError;
  if (report.lastRunAt !== undefined) set.lastRunAt = report.lastRunAt;
  if (Object.keys(set).length === 0) return;
  await db.update(smartCollections).set(set).where(eq(smartCollections.id, id));
}

/* ---------------------------------------------------------------- *
 * The store index
 * ---------------------------------------------------------------- */

const UPSERT_CHUNK = 500;

/**
 * Write rows into the index. A row only replaces one the store modified
 * EARLIER: a full read that started minutes ago must not put back what a
 * product looked like before the edit a later read already brought in.
 */
export async function upsertIndexRows(rows: IndexRow[], seenAt = new Date()): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const values = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({
      productId: r.id,
      sku: r.sku,
      name: r.name,
      type: r.type,
      status: r.status,
      permalink: r.permalink,
      categories: r.categories,
      tags: r.tags,
      brands: r.brands,
      attributes: r.attributes,
      price: r.price,
      onSale: r.onSale,
      stockStatus: r.stockStatus,
      dateCreated: r.dateCreated ? new Date(r.dateCreated) : null,
      dateModified: r.dateModified ? new Date(r.dateModified) : null,
      seenAt,
    }));
    await db
      .insert(storeIndex)
      .values(values)
      .onConflictDoUpdate({
        target: storeIndex.productId,
        set: {
          sku: sql`excluded.sku`,
          name: sql`excluded.name`,
          type: sql`excluded.type`,
          status: sql`excluded.status`,
          permalink: sql`excluded.permalink`,
          categories: sql`excluded.categories`,
          tags: sql`excluded.tags`,
          brands: sql`excluded.brands`,
          attributes: sql`excluded.attributes`,
          price: sql`excluded.price`,
          onSale: sql`excluded.on_sale`,
          stockStatus: sql`excluded.stock_status`,
          dateCreated: sql`excluded.date_created`,
          dateModified: sql`excluded.date_modified`,
          seenAt: sql`excluded.seen_at`,
        },
        setWhere: sql`${storeIndex.dateModified} is null or excluded.date_modified is null or excluded.date_modified >= ${storeIndex.dateModified}`,
      });
  }
}

/** Mark rows as seen without changing them (a full read that met an older copy). */
export async function touchIndexRows(ids: number[], seenAt: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.update(storeIndex).set({ seenAt }).where(inArray(storeIndex.productId, ids));
}

export async function deleteIndexRows(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(storeIndex).where(inArray(storeIndex.productId, ids));
}

/** Drop the products a complete read did not see: gone from the store, or binned. */
export async function deleteUnseen(before: Date): Promise<number> {
  const gone = await db.delete(storeIndex).where(lt(storeIndex.seenAt, before)).returning({ id: storeIndex.productId });
  return gone.length;
}

function rowToProduct(r: typeof storeIndex.$inferSelect): IndexRow {
  return {
    id: r.productId,
    sku: r.sku,
    name: r.name,
    type: r.type,
    status: r.status,
    permalink: r.permalink,
    categories: r.categories,
    tags: r.tags,
    brands: r.brands,
    attributes: r.attributes,
    price: r.price,
    onSale: r.onSale,
    stockStatus: r.stockStatus,
    dateCreated: r.dateCreated?.toISOString() ?? null,
    dateModified: r.dateModified?.toISOString() ?? null,
  };
}

/** The whole index — light rows, a few thousand at most per shop. */
export async function readIndex(): Promise<IndexRow[]> {
  const rows = await db.select().from(storeIndex).orderBy(storeIndex.productId);
  return rows.map(rowToProduct);
}

export interface IndexInfo {
  products: number;
  /** The newest modification the index holds: where the next check starts. */
  newestModified: Date | null;
  /** When a read last brought anything in. */
  lastSeen: Date | null;
}

export async function indexInfo(): Promise<IndexInfo> {
  const res = await db.execute(sql`
    select count(*)::int as n, max(${storeIndex.dateModified}) as newest, max(${storeIndex.seenAt}) as seen
    from ${storeIndex}
  `);
  const row = rowsOf<{ n: number | string; newest: string | Date | null; seen: string | Date | null }>(res)[0];
  const date = (v: string | Date | null | undefined) => (v == null ? null : new Date(v));
  return { products: Number(row?.n ?? 0), newestModified: date(row?.newest), lastSeen: date(row?.seen) };
}

/** Products directly in each of these categories, per the index. */
export async function countMembers(termIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>(termIds.map((id) => [id, 0]));
  if (termIds.length === 0) return out;
  const res = await db.execute(sql`
    select (c->>'id')::int as term, count(*)::int as n
    from ${storeIndex}, jsonb_array_elements(${storeIndex.categories}) as c
    where (c->>'id')::int in (${sql.join(
      termIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    group by 1
  `);
  for (const row of rowsOf<{ term: number | string; n: number | string }>(res)) {
    out.set(Number(row.term), Number(row.n));
  }
  return out;
}

/** Most values listed per attribute in the rule editor. */
const OPTIONS_PER_ATTRIBUTE = 300;

/**
 * The attributes the store's products carry, with the values they take —
 * what the rule editor offers, so a rule is written against values that exist.
 */
export async function attributeOptions(): Promise<{ key: string; name: string; options: string[] }[]> {
  const res = await db.execute(sql`
    select a->>'key' as key, max(a->>'name') as name, array_agg(distinct o) as options
    from ${storeIndex},
         jsonb_array_elements(${storeIndex.attributes}) as a,
         jsonb_array_elements_text(a->'options') as o
    group by a->>'key'
  `);
  return rowsOf<{ key: string; name: string | null; options: string[] | null }>(res)
    .map((r) => ({
      key: r.key,
      name: r.name ?? r.key,
      options: (r.options ?? [])
        .filter((o) => o.trim() !== "")
        .sort((a, b) => a.localeCompare(b, "it", { numeric: true, sensitivity: "base" }))
        .slice(0, OPTIONS_PER_ATTRIBUTE),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" }));
}

/* ---------------------------------------------------------------- *
 * The log
 * ---------------------------------------------------------------- */

export type NewChange = typeof collectionChanges.$inferInsert;

export async function logChanges(rows: NewChange[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await db.insert(collectionChanges).values(rows.slice(i, i + UPSERT_CHUNK));
  }
}

export async function listChanges(opts: { collectionId?: string; productId?: number; limit?: number } = {}): Promise<
  CollectionChangeRow[]
> {
  const conds = [];
  if (opts.collectionId) conds.push(eq(collectionChanges.collectionId, opts.collectionId));
  if (opts.productId) conds.push(eq(collectionChanges.productId, opts.productId));
  return db
    .select()
    .from(collectionChanges)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(collectionChanges.at))
    .limit(opts.limit ?? 50);
}

const LOG_DAYS = 60;

export async function pruneChanges(): Promise<void> {
  await db.delete(collectionChanges).where(lt(collectionChanges.at, new Date(Date.now() - LOG_DAYS * 86_400_000)));
}

export type { IndexedProduct };
