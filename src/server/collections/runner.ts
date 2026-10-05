import "server-only";
import {
  decideProduct,
  orderCollections,
  planCollections,
  type EvalContext,
  type IndexedTerm,
  type SmartCollection,
} from "@core/collections";
import { env } from "@/lib/env";
import type { WooClient } from "@/server/woo/client";
import { pageVerdict } from "@/server/woo/paginate";
import { gmtToIso, parentsOf, toIndexRow, type IndexRow } from "./index-rows";
import * as repo from "./repo";
import { storeClient, storeReady } from "./store";

/**
 * The automatic categories' runs: keep the store index fresh, decide every
 * product against every rule, write what changes.
 *
 * - The CHECK (every few minutes, from the scheduler): ask the store what
 *   changed since the newest change the index holds — usually nothing, one
 *   light request — then decide. Deciding also runs when nothing changed:
 *   "created in the last 30 days" moves products with no edit at all.
 * - The FULL READ (daily, and on demand): every product again, which is how
 *   the index learns what the check cannot see — a product binned or
 *   deleted, a change that did not touch the product's modified time.
 * - The DECISION reads the index, never the live store, so it is cheap
 *   enough to run every time; but every product it is about to write is
 *   READ AGAIN live and decided on that, so a stale index can cost a write
 *   that turns out unnecessary, never a wrong one.
 *
 * One run at a time, in arrival order: two decisions writing the same
 * product's categories from two different readings is the one thing this
 * must never do. State lives on globalThis, like the scheduler's: the
 * instrumentation bundle and the server actions each get their own copy of
 * this module.
 */

const PER_PAGE = 100;
/** A full read stops here: 50 000 products. */
const MAX_FULL_PAGES = 500;
/** A check reads at most this many pages; the next check carries on from there. */
const MAX_CHECK_PAGES = 20;
/** The check starts this long before the newest change held: same-second edits, clocks. */
const OVERLAP_MS = 10 * 60_000;
/** Products re-read and written per request: each one is a full product save on the shop. */
const WRITE_CHUNK = 25;
/** A product the store refused is not tried again by the automatic runs for this long. */
const REFUSED_PAUSE_MS = 60 * 60_000;
const DEFAULT_MAX_CHANGES = 200;

/**
 * What a run is: a full read, a check for changes, a change confirmed by
 * hand ("apply" — the one requests for a confirmation ride along with), or
 * the decision about one product whose tags were just edited.
 */
export type RunKind = "full" | "check" | "apply" | "product";

export interface RunnerStatus {
  /** What is running now. */
  running: RunKind | null;
  /** Of the running task: products read or written so far, of how many. */
  progress: { done: number; total: number | null } | null;
  queued: RunKind[];
  lastFullAt: number | null;
  lastCheckAt: number | null;
  /** Products the last decision moved. */
  lastMoved: number | null;
  lastError: string | null;
  /**
   * False once the store has shown it ignores "modified after" (it answered
   * with its whole catalogue): only the full reads keep the index fresh then.
   */
  incremental: boolean | null;
}

interface State extends RunnerStatus {
  chain: Promise<void>;
  /** Collections confirmed by hand, for the next apply run to take. */
  confirm: Set<string>;
  /** Products the store refused, and when: the automatic runs leave them be for a while. */
  refused: Map<number, number>;
}

const g = globalThis as { __storeHubCollections?: State };

function state(): State {
  return (g.__storeHubCollections ??= {
    chain: Promise.resolve(),
    running: null,
    progress: null,
    queued: [],
    lastFullAt: null,
    lastCheckAt: null,
    lastMoved: null,
    lastError: null,
    incremental: null,
    confirm: new Set(),
    refused: new Map(),
  });
}

export function getRunnerStatus(): RunnerStatus {
  const s = state();
  return {
    running: s.running,
    progress: s.progress ? { ...s.progress } : null,
    queued: [...s.queued],
    lastFullAt: s.lastFullAt,
    lastCheckAt: s.lastCheckAt,
    lastMoved: s.lastMoved,
    lastError: s.lastError,
    incremental: s.incremental,
  };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function maxChanges(): number {
  return env.COLLECTIONS_MAX_CHANGES ?? DEFAULT_MAX_CHANGES;
}

/** Run `fn` after everything queued before it; its failure is remembered and passed on. */
function exclusive<T>(kind: RunKind, fn: () => Promise<T>): Promise<T> {
  const s = state();
  s.queued.push(kind);
  const run = s.chain.then(async () => {
    s.queued.splice(s.queued.indexOf(kind), 1);
    s.running = kind;
    s.progress = null;
    try {
      const result = await fn();
      s.lastError = null;
      return result;
    } catch (e) {
      s.lastError = messageOf(e);
      console.error(`[collections] ${kind} failed: ${s.lastError}`);
      throw e;
    } finally {
      s.running = null;
      s.progress = null;
    }
  });
  s.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ---------------------------------------------------------------- *
 * Reading the store
 * ---------------------------------------------------------------- */

/**
 * Every product, page by page. Only a read that walked the whole store may
 * say what is gone from it: one cut short (a store that stopped paginating,
 * the ceiling) keeps every row it did not see.
 */
async function readAll(woo: WooClient): Promise<number> {
  const s = state();
  const startedAt = new Date();
  const seen = new Set<number>();
  let complete = false;
  for (let page = 1; page <= MAX_FULL_PAGES; page++) {
    const { products, total } = await woo.getProductIndexPage({ page, perPage: PER_PAGE });
    const fresh = products.filter((p) => !seen.has(p.id));
    for (const p of fresh) seen.add(p.id);
    const rows = fresh.map(toIndexRow);
    const now = new Date();
    await repo.upsertIndexRows(rows, now);
    // A row the upsert kept (the index already held a newer one) was seen all the same.
    await repo.touchIndexRows(
      rows.map((r) => r.id),
      now,
    );
    s.progress = { done: seen.size, total };
    const verdict = pageVerdict({ page, rows: products.length, fresh: fresh.length, perPage: PER_PAGE, maxPages: MAX_FULL_PAGES });
    if (verdict === "continue") continue;
    complete = verdict === "complete";
    if (!complete) {
      console.warn(
        `[collections] full read stopped at page ${page} (${verdict}) with ${seen.size} products: ` +
          "products the store no longer has stay in the index until a complete read.",
      );
    }
    break;
  }
  if (complete) {
    const gone = await repo.deleteUnseen(startedAt);
    if (gone > 0) console.log(`[collections] ${gone} product(s) gone from the store, dropped from the index`);
  }
  s.lastFullAt = Date.now();
  return seen.size;
}

/**
 * What changed since the newest change the index holds.
 *
 * The store is read whole instead until a full read has gone through in this
 * process: the first check after a deploy or a crash, an empty index, a full
 * read that failed half-way. A check only ever adds what changed, so an index
 * left incomplete would otherwise stay so until the daily read.
 *
 * A store that ignores "modified after" answers with everything, oldest
 * first — seen at once, said once, and from then on the full reads alone keep
 * the index fresh.
 *
 * More changes than a check reads in one go (a CSV import, a bulk edit of
 * thousands) also mean a full read: the check starts a little before the
 * newest change it holds, and with thousands changed in that window it would
 * read the same first pages every time and never reach the rest.
 */
async function readChanges(woo: WooClient): Promise<number> {
  const s = state();
  const info = await repo.indexInfo();
  if (s.lastFullAt == null || info.products === 0 || !info.newestModified) return readAll(woo);
  if (s.incremental === false) return 0;
  const since = new Date(Math.min(info.newestModified.getTime(), Date.now()) - OVERLAP_MS);
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const { products } = await woo.getProductIndexPage({ page, perPage: PER_PAGE, modifiedAfter: since });
    const ignored = products.some((p) => {
      const modified = gmtToIso(p.date_modified_gmt);
      return modified != null && Date.parse(modified) < since.getTime() - 60_000;
    });
    if (ignored) {
      s.incremental = false;
      console.warn(
        "[collections] the store ignores modified_after (WooCommerce older than 5.8, or a plugin " +
          "stripping it): changes are picked up by the daily full read only.",
      );
      return seen.size;
    }
    s.incremental = true;
    const fresh = products.filter((p) => !seen.has(p.id));
    for (const p of fresh) seen.add(p.id);
    await repo.upsertIndexRows(fresh.map(toIndexRow));
    const verdict = pageVerdict({ page, rows: products.length, fresh: fresh.length, perPage: PER_PAGE, maxPages: MAX_CHECK_PAGES });
    if (verdict === "capped") {
      console.log(`[collections] more than ${seen.size} products changed: reading the whole store`);
      return readAll(woo);
    }
    if (verdict !== "continue") break;
  }
  return seen.size;
}

/* ---------------------------------------------------------------- *
 * Deciding and writing
 * ---------------------------------------------------------------- */

async function context(woo: WooClient): Promise<{ ctx: EvalContext; categoryIds: Set<number> }> {
  const [categories, brands] = await Promise.all([
    woo.listCategories(),
    // A store without the brands taxonomy simply has no brand rules to satisfy.
    woo.listBrands().catch(() => []),
  ]);
  return {
    ctx: { now: Date.now(), categoryParents: parentsOf(categories), brandParents: parentsOf(brands) },
    categoryIds: new Set(categories.map((c) => c.id)),
  };
}

type Trigger = "auto" | "manual" | "product";

interface WriteOutcome {
  moved: number;
  /** The store's reason, per collection that had a product refused. */
  refused: Map<string, string>;
  /** Per product written: the collections it joined and left. */
  decided: Map<number, { joined: string[]; left: string[]; error: string | null }>;
}

/**
 * Read these products again, live, decide each on what the store says NOW,
 * and write the ones whose categories change — a few at a time, logging
 * every product moved and refreshing the index from the store's answer.
 */
async function writeDecisions(
  woo: WooClient,
  ids: number[],
  ordered: SmartCollection[],
  ctx: EvalContext,
  frozen: ReadonlySet<string>,
  trigger: Trigger,
  confirmed: ReadonlySet<string> = new Set(),
): Promise<WriteOutcome> {
  const s = state();
  const byId = new Map(ordered.map((c) => [c.id, c]));
  const outcome: WriteOutcome = { moved: 0, refused: new Map(), decided: new Map() };
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    const chunk = ids.slice(i, i + WRITE_CHUNK);
    const { products } = await woo.getProductIndexPage({ page: 1, perPage: chunk.length, include: chunk });
    const live = products.map(toIndexRow);
    await repo.upsertIndexRows(live);
    // Not answered for: binned or deleted since the index last saw it.
    await repo.deleteIndexRows(chunk.filter((id) => !live.some((p) => p.id === id)));

    const pending = live
      .map((p) => ({ p, d: decideProduct(p, ordered, ctx, frozen) }))
      .filter(({ d }) => d.joined.length > 0 || d.left.length > 0);
    if (pending.length > 0) {
      const answers = new Map(
        (
          await woo.batchUpdateProducts(
            pending.map(({ d }) => ({ id: d.productId, categories: d.after.map((id) => ({ id })) })),
          )
        ).map((r) => [r.id, r]),
      );
      const saved: IndexRow[] = [];
      const log: repo.NewChange[] = [];
      for (const { p, d } of pending) {
        const answer = answers.get(p.id);
        const error = answer ? answer.error : "no answer for this product";
        if (answer?.product) saved.push(toIndexRow(answer.product));
        if (error) s.refused.set(p.id, Date.now());
        else {
          s.refused.delete(p.id);
          outcome.moved += 1;
        }
        outcome.decided.set(p.id, { joined: d.joined, left: d.left, error });
        const moves = [
          ...d.joined.map((id) => ({ id, action: "add" as const })),
          ...d.left.map((id) => ({ id, action: "remove" as const })),
        ];
        for (const { id, action } of moves) {
          const c = byId.get(id);
          if (!c) continue;
          if (error) outcome.refused.set(id, error);
          log.push({
            collectionId: c.id,
            termId: c.termId,
            categoryName: c.name,
            productId: p.id,
            sku: p.sku,
            productName: p.name,
            action,
            trigger: trigger === "product" ? "product" : confirmed.has(c.id) ? "manual" : "auto",
            error,
          });
        }
      }
      await repo.upsertIndexRows(saved);
      await repo.logChanges(log);
    }
    s.progress = { done: Math.min(i + chunk.length, ids.length), total: ids.length };
  }
  return outcome;
}

/**
 * Decide the whole index and write the difference. Collections the safety
 * net catches are held (reported, left alone) unless `confirmed`; a rule
 * whose category is gone from the store, or that closes a loop, is reported
 * and left alone too. Returns the products moved.
 */
async function decide(woo: WooClient, confirmed: ReadonlySet<string>): Promise<number> {
  const s = state();
  const rows = await repo.listCollectionRows();
  const all = rows.map(repo.toCollection);
  if (!all.some((c) => c.enabled)) {
    s.lastMoved = 0;
    return 0;
  }
  const { ctx, categoryIds } = await context(woo);
  const missing = new Set(all.filter((c) => !categoryIds.has(c.termId)).map((c) => c.id));
  const products = await repo.readIndex();
  const plan = planCollections(
    products,
    all.filter((c) => !missing.has(c.id)),
    ctx,
    { limits: { maxChanges: maxChanges() }, confirmed },
  );
  const frozen = new Set([...plan.held.keys(), ...plan.cyclic.map((c) => c.id)]);

  // The automatic runs give a product the store refused an hour before
  // trying again: a refusal is usually a product only a person can fix.
  const now = Date.now();
  const ids = plan.changed
    .map((d) => d.productId)
    .filter((id) => confirmed.size > 0 || now - (s.refused.get(id) ?? 0) > REFUSED_PAUSE_MS);
  const outcome = await writeDecisions(woo, ids, plan.ordered, ctx, frozen, "auto", confirmed);

  const members = await repo.countMembers(all.map((c) => c.termId));
  const ranAt = new Date();
  const cyclic = new Set(plan.cyclic.map((c) => c.id));
  for (const c of all) {
    const report: repo.CollectionReport = { members: members.get(c.termId) ?? 0 };
    if (!c.enabled) {
      report.held = null;
    } else if (missing.has(c.id)) {
      report.lastError = "category_missing";
    } else if (cyclic.has(c.id)) {
      report.lastError = "loop";
    } else {
      const held = plan.held.get(c.id);
      report.held = held
        ? { reason: held.reason, joining: held.diff.joining.length, leaving: held.diff.leaving.length }
        : null;
      report.lastError = outcome.refused.get(c.id) ?? null;
      report.lastRunAt = ranAt;
    }
    await repo.reportCollection(c.id, report);
  }
  for (const [id, { reason }] of plan.held) {
    const c = all.find((x) => x.id === id);
    console.warn(`[collections] «${c?.name ?? id}» held for confirmation (${reason})`);
  }
  if (outcome.moved > 0) console.log(`[collections] ${outcome.moved} product(s) moved`);
  s.lastMoved = outcome.moved;
  return outcome.moved;
}

/* ---------------------------------------------------------------- *
 * Entry points
 * ---------------------------------------------------------------- */

async function anyEnabled(): Promise<boolean> {
  return (await repo.listCollectionRows()).some((r) => r.enabled);
}

/** Who the runs talk to: the store, or (tests) a stand-in for it. */
export interface RunOptions {
  client?: WooClient;
}

/**
 * The scheduler's frequent check. Null when there is nothing to do: the store
 * is not configured, or no category is automatic — then not a single request
 * reaches the store.
 */
export async function runCheck(opts: RunOptions = {}): Promise<{ read: number; moved: number } | null> {
  if ((!opts.client && !storeReady()) || !(await anyEnabled())) return null;
  return exclusive("check", async () => {
    const woo = opts.client ?? (await storeClient());
    const read = await readChanges(woo);
    const moved = await decide(woo, new Set());
    state().lastCheckAt = Date.now();
    return { read, moved };
  });
}

/** The daily pass: the whole store again, then the decision, then the log's tail trimmed. */
export async function runFull(opts: RunOptions = {}): Promise<{ read: number; moved: number } | null> {
  if ((!opts.client && !storeReady()) || !(await anyEnabled())) return null;
  return exclusive("full", async () => {
    const woo = opts.client ?? (await storeClient());
    const read = await readAll(woo);
    const moved = await decide(woo, new Set());
    await repo.pruneChanges().catch((e) => console.warn(`[collections] log not trimmed: ${messageOf(e)}`));
    state().lastCheckAt = Date.now();
    return { read, moved };
  });
}

/**
 * Catch up with the store and decide, these collections confirmed by hand
 * (no safety net for them). What requestApply runs in the background.
 */
export async function applyConfirmed(ids: string[], opts: RunOptions = {}): Promise<number> {
  return exclusive("apply", async () => {
    const woo = opts.client ?? (await storeClient());
    await readChanges(woo);
    const moved = await decide(woo, new Set(ids));
    state().lastCheckAt = Date.now();
    return moved;
  });
}

const background = (run: Promise<unknown>) => void run.catch(() => undefined);

/** From the Hub: read every product again (the editor's previews need the index), then decide. */
export function requestFullRead(): void {
  const s = state();
  if (!storeReady() || s.queued.includes("full")) return;
  background(
    exclusive("full", async () => {
      const woo = await storeClient();
      await readAll(woo);
      await decide(woo, new Set());
      s.lastCheckAt = Date.now();
    }),
  );
}

/** From the Hub, on opening the editor: catch up with the store if a check is not already due. */
export function requestCheck(): void {
  const s = state();
  if (!storeReady() || s.queued.length > 0) return;
  background(
    exclusive("check", async () => {
      const woo = await storeClient();
      await readChanges(woo);
      await decide(woo, new Set());
      s.lastCheckAt = Date.now();
    }),
  );
}

/**
 * A rule saved, or a held change confirmed, by hand: catch up with the store
 * and decide — that collection with no safety net, since a person just said
 * yes to it. Requests arriving while one is queued ride along with it.
 */
export function requestApply(collectionId?: string): void {
  const s = state();
  if (!storeReady()) return;
  if (collectionId) s.confirm.add(collectionId);
  if (s.queued.includes("apply")) return;
  background(
    exclusive("apply", async () => {
      const confirmed = new Set(s.confirm);
      s.confirm.clear();
      const woo = await storeClient();
      await readChanges(woo);
      await decide(woo, confirmed);
      s.lastCheckAt = Date.now();
    }),
  );
}

/* ---------------------------------------------------------------- *
 * One product's tags, edited from the Hub
 * ---------------------------------------------------------------- */

export interface TagEdit {
  /** The product's tags as saved on the store. */
  tags: IndexedTerm[];
  /** Automatic categories it joined and left right away (names). */
  joined: string[];
  left: string[];
  /** The decision is still queued behind a longer run: it happens shortly. */
  pending: boolean;
  /** The store refused the category change (the tags are saved). */
  error: string | null;
}

/** How long a tag edit waits for its decision before answering "shortly". */
const PRODUCT_WAIT_MS = 15_000;

/**
 * Set a product's tags — existing ones by id, new ones by name (created on
 * the store) — and decide that product at once, so the categories that read
 * those tags follow while the person is still looking.
 *
 * The tags are written outside the run queue: a product save that carries
 * only tags never touches categories, so it cannot race a decision. The
 * decision itself queues like any other.
 */
export async function setProductTags(
  productId: number,
  wanted: { id?: number; name: string }[],
  opts: RunOptions = {},
): Promise<TagEdit> {
  const woo = opts.client ?? (await storeClient());
  const ids: number[] = [];
  const missing = wanted.filter((t) => !t.id);
  const existing = missing.length > 0 ? await woo.listTags() : [];
  for (const t of wanted) {
    if (t.id) {
      ids.push(t.id);
      continue;
    }
    const name = t.name.trim();
    if (!name) continue;
    const found = existing.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    const created = found ?? (await woo.createTag(name)) ?? (await woo.listTags()).find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    if (!created) throw new Error(`the store did not accept the tag «${name}»`);
    ids.push(created.id);
  }
  const [answer] = await woo.batchUpdateProducts([{ id: productId, tags: [...new Set(ids)].map((id) => ({ id })) }]);
  if (!answer?.product) throw new Error(answer?.error ?? "the store did not answer");
  const row = toIndexRow(answer.product);
  await repo.upsertIndexRows([row]);

  const result: TagEdit = { tags: row.tags, joined: [], left: [], pending: false, error: null };
  if (!(await anyEnabled())) return result;

  const decision = exclusive("product", async () => {
    const rows = await repo.listCollectionRows();
    const all = rows.map(repo.toCollection);
    const { ctx, categoryIds } = await context(woo);
    const decidable = all.filter((c) => c.enabled && categoryIds.has(c.termId));
    const { ordered, cyclic } = orderCollections(decidable, ctx.categoryParents);
    // What waits for a confirmation keeps waiting: one product does not get to skip it.
    const frozen = new Set([...cyclic.map((c) => c.id), ...rows.filter((r) => r.held).map((r) => r.id)]);
    return writeDecisions(woo, [productId], ordered, ctx, frozen, "product");
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PRODUCT_WAIT_MS).unref());
  const outcome = await Promise.race([decision.catch((e: unknown) => ({ error: messageOf(e) })), timeout]);
  if (outcome == null) return { ...result, pending: true };
  if ("error" in outcome) return { ...result, error: outcome.error };
  const decided = outcome.decided.get(productId);
  if (!decided) return result;
  const names = new Map((await repo.listCollectionRows()).map((r) => [r.id, r.name]));
  return {
    ...result,
    joined: decided.joined.map((id) => names.get(id) ?? id),
    left: decided.left.map((id) => names.get(id) ?? id),
    error: decided.error,
  };
}
