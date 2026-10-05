import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { mediaJobs, type MediaJobRow } from "@/server/db/schema";
import { upsertSnapshotProducts } from "@/server/store-json/repo";
import { skuKey } from "@/lib/skus";
import { getWooClient, type WooClient, type WooRestProduct } from "./client";
import { mediaImages, nextMediaStep, photosOn, type MediaJobView, type MediaLiveProduct } from "./media-plan";
import { publishing } from "./publishing";
import { toStoreProduct } from "./store-product";

/**
 * The photo queue: the photos the Publisher no longer sends with the create.
 *
 * WordPress downloads every photo and cuts it into every thumbnail size inside
 * the request that attaches it — the slow half of a first import. So a product
 * is now created hidden (a draft) and without photos, and files one row here.
 * A worker (the scheduler's, or /api/cron/media) attaches the photos one
 * request at a time, main photo first, and puts the product on sale with it.
 * Products still off sale go first, so a big import is on sale long before
 * its last gallery shot lands.
 *
 * What it never does is send a photo twice. A request that got no answer is
 * looked at again minutes later — the planner (media-plan) recognizes each
 * photo by the name it was filed under — and is sent again only if the photo
 * did not land.
 */

/** A claim outlives any one step: a photo has 95 s, a product read seconds. */
const LOCK_MS = 10 * 60_000;
/** Failed tries in a row before a job stops and waits for the operator. */
const MAX_ATTEMPTS = 8;
/** Refusals of one photo before the queue goes on without it: a download can fail once. */
const MAX_REFUSALS = 2;
/** After a lost answer, the time WordPress gets to finish before the product is looked at again. */
const CHECK_AFTER_MS = 3 * 60_000;
/** A job filed before its create waits this long for the product to appear. */
const ORPHAN_MS = 30 * 60_000;
const NOT_CREATED_YET_MS = 2 * 60_000;
/** A store that does not answer is asked again after this — without spending anyone's tries. */
const UNREACHABLE_MS = 5 * 60_000;
/** Failed jobs the Publish tab lists. */
const FAILED_LIST_LIMIT = 50;

const NO_PHOTO = "no photo from the source: the product stays hidden until one is added in WooCommerce";
const NO_SIZES = "the product has no sizes: it goes on sale once it has them";

/** What the queue asks of the store — the Woo client, or a stand-in in tests. */
export type MediaClient = Pick<WooClient, "findProductsBySku" | "getProduct" | "updateProductOnce" | "getAllVariations">;

type JobPatch = Partial<typeof mediaJobs.$inferInsert>;

/**
 * File a product's photos. One open job per SKU: filing again replaces the
 * photos of the open one, and a product still waiting to go on sale keeps
 * waiting for it.
 */
export async function queueMedia(input: {
  sku: string;
  /** Null when filed before the create: the worker finds the product by SKU. */
  storeProductId: number | null;
  title: string;
  /** Main photo first. None at all still files the job: the product stays hidden, and the tab says why. */
  urls: string[];
  /** Put the product on sale once it has a photo. */
  publish: boolean;
  /** Replace the photos the product has, instead of only filling it. */
  replace?: boolean;
}): Promise<void> {
  const sku = skuKey(input.sku);
  // Each job's photos get names of their own, so a later job never takes an
  // earlier one's photos for its own (see media-plan).
  const token = randomBytes(3).toString("hex");
  const now = new Date();
  await db
    .insert(mediaJobs)
    .values({
      sku,
      storeProductId: input.storeProductId,
      title: input.title,
      images: mediaImages(sku, input.urls, token),
      publish: input.publish,
      replace: input.replace ?? false,
      // The worker's clock, not the database's: its now() has microseconds a
      // claim made in the same millisecond would read as "not yet".
      nextAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: mediaJobs.sku,
      targetWhere: sql`status = 'pending'`,
      set: {
        storeProductId: sql`coalesce(excluded.store_product_id, ${mediaJobs.storeProductId})`,
        title: sql`excluded.title`,
        images: sql`excluded.images`,
        refusals: sql`'{}'::jsonb`,
        publish: sql`${mediaJobs.publish} or excluded.publish`,
        replace: sql`${mediaJobs.replace} or excluded.replace`,
        attached: 0,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        updatedAt: now,
      },
    });
}

/** The parent exists now: point its open job at it. */
export async function setMediaProduct(sku: string, storeProductId: number): Promise<void> {
  await db
    .update(mediaJobs)
    .set({ storeProductId, updatedAt: new Date() })
    .where(and(eq(mediaJobs.sku, skuKey(sku)), eq(mediaJobs.status, "pending")));
}

/** The create failed for certain: the photos filed for it have nothing to go to. */
export async function dropMedia(sku: string): Promise<void> {
  const now = new Date();
  await db
    .update(mediaJobs)
    .set({ status: "cancelled", lastError: "the product was not created", finishedAt: now, updatedAt: now })
    .where(and(eq(mediaJobs.sku, skuKey(sku)), eq(mediaJobs.status, "pending"), isNull(mediaJobs.storeProductId)));
}

/** SKUs whose photos are still on their way: hidden products count as published. */
export async function openMediaSkus(): Promise<Set<string>> {
  const rows = await db.select({ sku: mediaJobs.sku }).from(mediaJobs).where(eq(mediaJobs.status, "pending"));
  return new Set(rows.map((r) => r.sku));
}

// ---- the worker ----------------------------------------------------------

/** Claim up to `limit` due jobs: products off sale first, then replacements, then galleries. */
async function claim(limit: number): Promise<MediaJobRow[]> {
  const now = new Date();
  // A SKU being published right now gets its photos once its publish is over.
  const busy = [...publishing];
  const due = db
    .select({ id: mediaJobs.id })
    .from(mediaJobs)
    .where(
      and(
        eq(mediaJobs.status, "pending"),
        lte(mediaJobs.nextAttemptAt, now),
        or(isNull(mediaJobs.lockedUntil), lt(mediaJobs.lockedUntil, now)),
        busy.length > 0 ? notInArray(mediaJobs.sku, busy) : undefined,
      ),
    )
    .orderBy(sql`${mediaJobs.attached} > 0`, sql`not ${mediaJobs.publish}`, asc(mediaJobs.nextAttemptAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  return db
    .update(mediaJobs)
    .set({ lockedUntil: new Date(now.getTime() + LOCK_MS) })
    .where(inArray(mediaJobs.id, due))
    .returning();
}

/**
 * Record a step's outcome and let the job go — unless it was filed again
 * meanwhile (new photos), in which case it starts over and only the claim is
 * released.
 */
async function save(job: MediaJobRow, patch: JobPatch): Promise<void> {
  const saved = await db
    .update(mediaJobs)
    .set({ ...patch, lockedUntil: null, updatedAt: new Date() })
    .where(and(eq(mediaJobs.id, job.id), sql`${mediaJobs.images} = ${JSON.stringify(job.images)}::jsonb`))
    .returning({ id: mediaJobs.id });
  if (saved.length === 0) {
    await db.update(mediaJobs).set({ lockedUntil: null }).where(eq(mediaJobs.id, job.id));
  }
}

async function finish(
  job: MediaJobRow,
  status: "done" | "failed" | "cancelled",
  error: string | null,
  product?: WooRestProduct,
): Promise<void> {
  await save(job, {
    status,
    lastError: error,
    finishedAt: new Date(),
    ...(product ? { attached: countOn(job, product) } : {}),
  });
}

/** 1, 2, 4 … minutes, an hour at most. */
function backoff(attempts: number): number {
  return Math.min(60, 2 ** attempts) * 60_000;
}

/** A failed try: tried again later, until MAX_ATTEMPTS in a row stop the job. */
async function retryLater(job: MediaJobRow, error: string, delayMs = backoff(job.attempts)): Promise<void> {
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return finish(job, "failed", error);
  await save(job, { attempts, lastError: error, nextAttemptAt: new Date(Date.now() + delayMs) });
}

function view(job: MediaJobRow): MediaJobView {
  return {
    images: job.images,
    skipped: Object.entries(job.refusals)
      .filter(([, refused]) => refused >= MAX_REFUSALS)
      .map(([index]) => Number(index)),
    publish: job.publish,
    replace: job.replace,
    alt: job.title,
  };
}

async function liveOf(client: MediaClient, product: WooRestProduct): Promise<MediaLiveProduct> {
  const variations =
    product.variations != null ? product.variations.length : (await client.getAllVariations(product.id)).length;
  return { status: product.status, images: product.images ?? [], variations };
}

function countOn(job: MediaJobRow, product: WooRestProduct): number {
  return photosOn(job, { images: product.images ?? [] }).filter(Boolean).length;
}

/** No usable answer came back: a timeout, a dropped connection, a gateway error. */
function answerLost(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status == null || status >= 500;
}

/** Answers that say the store as a whole is out of reach, rather than anything about one product. */
const STORE_DOWN = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);

/** The store, not this job: no connection, too many requests, or the proxy in front got nothing from it. */
function storeDown(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status == null || STORE_DOWN.has(status);
}

/** The store would not take the photo itself — a dead link, not an image — rather than the request. */
function photoRefused(e: unknown): boolean {
  const err = e as { status?: number; body?: string };
  return (
    err?.status === 400 &&
    /woocommerce_product_image_upload_error|woocommerce_product_invalid_image_id/.test(err.body ?? "")
  );
}

/** What a failed request said, without its URL: WooCommerce's own message when there is one. */
function describe(e: unknown): string {
  const err = e as { status?: number; body?: string };
  let message = "";
  if (err?.status != null) {
    try {
      const parsed = JSON.parse(err.body ?? "") as { message?: unknown };
      if (typeof parsed?.message === "string") message = parsed.message;
    } catch {
      // An HTML page from the proxy in front: the status says enough.
    }
  } else {
    // "Request to <url> failed: <why>" — the why is what matters.
    message = (e instanceof Error ? e.message : String(e)).replace(/^Request to \S+ failed: /, "");
  }
  message = message.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const status = err?.status != null ? `HTTP ${err.status}` : "";
  return [message, status].filter(Boolean).join(" · ").slice(0, 300) || "unknown error";
}

/**
 * Bring the Hub's copy of the store up to date with products the queue put on
 * sale or finished. The store pull reads published products only, so a hidden
 * draft is missing from the copy (or left it at the last pull) — and the feed
 * cycle syncs from the copy, which must not wait a day for a product just put
 * on sale. They go in with their sizes, in one write per drain: every write
 * rewrites the copy. Best-effort, as every patch.
 */
async function recordOnSnapshot(client: MediaClient, products: WooRestProduct[]): Promise<void> {
  if (products.length === 0) return;
  try {
    const models = [];
    for (const p of products) models.push(toStoreProduct(p, await client.getAllVariations(p.id)));
    await upsertSnapshotProducts(models);
  } catch (e) {
    console.warn(`[media] the Hub's copy of the store not updated (${describe(e)})`);
  }
}

/**
 * One step of one job: one request that changes the store, at most. Returns
 * the product when the Hub's copy of the store should learn of it: just put on
 * sale, or finished.
 */
async function step(client: MediaClient, job: MediaJobRow): Promise<WooRestProduct | null> {
  let productId = job.storeProductId;
  if (productId == null) {
    const found = (await client.findProductsBySku(job.sku))[0];
    if (!found) {
      if (Date.now() - job.createdAt.getTime() > ORPHAN_MS) {
        await finish(job, "cancelled", "the product never reached the store");
      } else {
        await save(job, { nextAttemptAt: new Date(Date.now() + NOT_CREATED_YET_MS) });
      }
      return null;
    }
    productId = found.id;
    await db.update(mediaJobs).set({ storeProductId: productId }).where(eq(mediaJobs.id, job.id));
  }

  const product = await client.getProduct(productId);
  if (!product || product.status === "trash") {
    await finish(job, "cancelled", "the product is no longer on the store");
    return null;
  }
  const plan = nextMediaStep(view(job), await liveOf(client, product));
  if (plan.kind === "done") {
    await finish(job, "done", null, product);
    return onSale(product);
  }
  if (plan.kind === "noPhoto") {
    // Every photo refused: the last refusal says why better than a generic line.
    const refused = Object.keys(job.refusals).length > 0 && job.lastError;
    await finish(job, "failed", refused || NO_PHOTO, product);
    return null;
  }
  if (plan.kind === "waitForSizes") {
    await retryLater(job, NO_SIZES);
    return null;
  }

  let after: WooRestProduct;
  try {
    after = await client.updateProductOnce(productId, plan.body);
  } catch (e) {
    if (plan.kind === "attach" && photoRefused(e)) {
      const refused = (job.refusals[plan.index] ?? 0) + 1;
      const refusals = { ...job.refusals, [plan.index]: refused };
      const error = `photo ${plan.index + 1} refused: ${describe(e)}`;
      // Once more later — a download can fail for a moment — then without it.
      await save(
        job,
        refused >= MAX_REFUSALS
          ? { refusals, attempts: 0, lastError: error, nextAttemptAt: new Date() }
          : {
              refusals,
              attempts: job.attempts + 1,
              lastError: error,
              nextAttemptAt: new Date(Date.now() + backoff(job.attempts)),
            },
      );
      return null;
    }
    if (answerLost(e)) {
      // WordPress usually goes on and finishes after the answer is lost:
      // look at the product before sending anything again.
      await retryLater(job, `no answer from the store (${describe(e)}): checked before anything is sent again`, CHECK_AFTER_MS);
      return null;
    }
    throw e;
  }

  if (plan.kind === "attach" && !photosOn(job, { images: after.images ?? [] })[plan.index]) {
    // On the store, but not under its name: the next look could not tell it
    // is there, and would send it again.
    await finish(
      job,
      "failed",
      "the store did not keep the photo's name, so the queue cannot recognize its photos: stopped rather than send one twice",
      after,
    );
    return onSale(after);
  }
  const next = nextMediaStep(view(job), await liveOf(client, after));
  if (next.kind === "done") {
    await finish(job, "done", null, after);
    return onSale(after);
  }
  await save(job, { attached: countOn(job, after), attempts: 0, lastError: null, nextAttemptAt: new Date() });
  // Just put on sale: the feed cycle must see it before its gallery is done.
  return product.status !== "publish" ? onSale(after) : null;
}

/** The product, when it is on sale — the only kind the Hub's copy of the store holds. */
function onSale(product: WooRestProduct): WooRestProduct | null {
  return product.status === "publish" ? product : null;
}

/** A step's outcome: the product to record, or that the store would not answer at all. */
type Worked = { product: WooRestProduct | null; unreachable?: string };

async function work(client: MediaClient, job: MediaJobRow): Promise<Worked> {
  try {
    return { product: await step(client, job) };
  } catch (e) {
    const reason = describe(e);
    try {
      if (storeDown(e)) {
        // An outage is not this product's fault: it must not spend its tries
        // on it — a couple of hours down would fail the whole queue.
        await save(job, { lastError: `the store did not answer: ${reason}`, nextAttemptAt: new Date(Date.now() + UNREACHABLE_MS) });
        return { product: null, unreachable: reason };
      }
      await retryLater(job, reason);
    } catch (err) {
      console.error(`[media] ${job.sku}: the outcome was not recorded (${describe(err)})`);
    }
    return { product: null };
  }
}

export interface MediaDrain {
  /** Steps taken: requests that could change the store. */
  steps: number;
  /** Stopped at the budget with work still due. */
  more: boolean;
  /** The round stopped because the store did not answer: why. */
  unreachable?: string;
}

/**
 * Work the queue until nothing is due or the budget is spent, `concurrency`
 * products at a time — gently: each photo is a download and a round of
 * thumbnails on the shop's own server. `paused` is asked before each round.
 */
export async function drainMedia(opts: {
  budgetMs: number;
  concurrency: number;
  paused?: () => Promise<boolean>;
  client?: MediaClient;
}): Promise<MediaDrain> {
  const client = opts.client ?? getWooClient();
  const deadline = Date.now() + opts.budgetMs;
  const record = new Map<number, WooRestProduct>();
  let steps = 0;
  let more = true;
  let unreachable: string | undefined;
  try {
    while (Date.now() < deadline) {
      if (opts.paused && (await opts.paused())) {
        more = false;
        break;
      }
      const jobs = await claim(opts.concurrency);
      if (jobs.length === 0) {
        more = false;
        break;
      }
      const outcomes = await Promise.all(jobs.map((job) => work(client, job)));
      for (const { product } of outcomes) if (product) record.set(product.id, product);
      steps += jobs.length;
      // The store is down: asking the next products would only hear the same.
      unreachable = outcomes.find((o) => o.unreachable)?.unreachable;
      if (unreachable) {
        more = false;
        break;
      }
    }
  } finally {
    await recordOnSnapshot(client, [...record.values()]);
  }
  return unreachable ? { steps, more, unreachable } : { steps, more };
}

// ---- the Publish tab -----------------------------------------------------

export interface MediaQueueItem {
  id: string;
  sku: string;
  title: string;
  storeProductId: number | null;
  /** This job's photos on the product, of `total`. */
  attached: number;
  total: number;
  error: string | null;
  at: number; // epoch ms of the last change
}

export interface MediaQueueState {
  /** Hidden products waiting for their first photo. */
  hidden: number;
  /** Products on sale with more photos to come. */
  photos: number;
  /** Jobs that stopped and wait for the operator, newest first (bounded). */
  failed: MediaQueueItem[];
  failedTotal: number;
}

/**
 * A failed job still worth showing: no newer job was filed for its SKU since.
 * The outer row is named outright: a column the builder left unqualified
 * would resolve to the inner one, and every row would pass.
 */
const latestForSku = sql`not exists (
  select 1 from media_jobs newer
  where newer.sku = media_jobs.sku and newer.created_at > media_jobs.created_at
)`;

export async function getMediaQueueState(): Promise<MediaQueueState> {
  const hiddenWhere = sql`${mediaJobs.attached} = 0 and ${mediaJobs.publish}`;
  const [counts] = await db
    .select({
      hidden: sql<number>`count(*) filter (where ${mediaJobs.status} = 'pending' and ${hiddenWhere})`.mapWith(Number),
      photos: sql<number>`count(*) filter (where ${mediaJobs.status} = 'pending' and not (${hiddenWhere}))`.mapWith(
        Number,
      ),
      failed: sql<number>`count(*) filter (where ${mediaJobs.status} = 'failed' and ${latestForSku})`.mapWith(Number),
    })
    .from(mediaJobs);
  const failed = await db
    .select()
    .from(mediaJobs)
    .where(and(eq(mediaJobs.status, "failed"), latestForSku))
    .orderBy(desc(mediaJobs.updatedAt))
    .limit(FAILED_LIST_LIMIT);
  return {
    hidden: counts?.hidden ?? 0,
    photos: counts?.photos ?? 0,
    failedTotal: counts?.failed ?? 0,
    failed: failed.map((j) => ({
      id: j.id,
      sku: j.sku,
      title: j.title,
      storeProductId: j.storeProductId,
      attached: j.attached,
      total: j.images.length,
      error: j.lastError,
      at: j.updatedAt.getTime(),
    })),
  };
}

/**
 * Put the failed jobs back in the queue, from scratch: refused photos are
 * tried again, and a photo added by hand meanwhile is found and kept.
 * Returns how many.
 */
export async function retryFailedMedia(): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(mediaJobs)
    .set({
      status: "pending",
      attempts: 0,
      refusals: {},
      lastError: null,
      finishedAt: null,
      nextAttemptAt: now,
      lockedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(mediaJobs.status, "failed"),
        latestForSku,
        // One open job per SKU: one filed since stands.
        sql`not exists (select 1 from media_jobs other where other.sku = media_jobs.sku and other.status = 'pending')`,
      ),
    )
    .returning({ id: mediaJobs.id });
  return rows.length;
}

/** Take the failed jobs off the list: the operator has seen to those products. Returns how many. */
export async function dismissFailedMedia(): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(mediaJobs)
    .set({ status: "cancelled", updatedAt: now })
    .where(eq(mediaJobs.status, "failed"))
    .returning({ id: mediaJobs.id });
  return rows.length;
}
