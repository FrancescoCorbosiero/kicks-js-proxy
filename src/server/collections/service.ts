import "server-only";
import {
  FIELD_VALUE,
  previewCollection,
  ruleProblems,
  type CollectionCondition,
  type EvalContext,
  type SmartCollection,
} from "@core/collections";
import type {
  ChangeView,
  CollectionDraft,
  CollectionOptions,
  CollectionsState,
  CollectionsStatus,
  CollectionView,
  DraftCheck,
  DraftProblem,
  ProductTagsResult,
  ProductTagsView,
  RailCollection,
  TermEditor,
  TermOption,
} from "@/lib/collections/types";
import type { WooClient } from "@/server/woo/client";
import { decodeEntities, parentsOf, toIndexRow } from "./index-rows";
import * as repo from "./repo";
import { getRunnerStatus, maxChanges, requestApply, requestCheck, requestFullRead, setProductTags } from "./runner";
import { demoMode, storeClient, storeReady } from "./store";

/**
 * The automatic categories' service: what the Hub's page and the Vetrina's
 * sheet read, check and save. The runs themselves are runner.ts.
 */

/** A failure the editor explains in its own words. */
export class CollectionError extends Error {
  constructor(
    readonly code: "not_configured" | "invalid" | "not_found" | "store",
    message: string,
  ) {
    super(message);
    this.name = "CollectionError";
  }
}

async function woo(): Promise<WooClient> {
  if (!storeReady()) throw new CollectionError("not_configured", "WooCommerce is not configured");
  return storeClient();
}

type Term = { id: number; name: string; slug: string; parent?: number };

/** Each term's name with its parents' before it: "Saldi › Nike". */
function paths(list: Term[]): Map<number, string> {
  const byId = new Map(list.map((t) => [t.id, t]));
  const out = new Map<number, string>();
  for (const term of list) {
    const names: string[] = [];
    let current: Term | undefined = term;
    for (let depth = 0; current && depth < 20; depth++) {
      names.unshift(decodeEntities(current.name));
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    out.set(term.id, names.join(" › "));
  }
  return out;
}

const byPath = (a: TermOption, b: TermOption) => a.path.localeCompare(b.path, "it", { sensitivity: "base" });

function termOptions(list: Term[]): TermOption[] {
  const named = paths(list);
  return list
    .map((t) => ({ id: t.id, name: decodeEntities(t.name), path: named.get(t.id) ?? decodeEntities(t.name) }))
    .sort(byPath);
}

/* ---------------------------------------------------------------- *
 * Reading
 * ---------------------------------------------------------------- */

function view(row: Awaited<ReturnType<typeof repo.listCollectionRows>>[number]): CollectionView {
  return {
    ...repo.toCollection(row),
    members: row.members,
    held: row.held ?? null,
    lastError: row.lastError,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function changeView(row: Awaited<ReturnType<typeof repo.listChanges>>[number]): ChangeView {
  return {
    id: row.id,
    at: row.at.toISOString(),
    collectionId: row.collectionId,
    categoryName: row.categoryName,
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    action: row.action,
    trigger: row.trigger,
    error: row.error,
  };
}

export async function loadStatus(): Promise<CollectionsStatus> {
  const [rows, info, changes] = await Promise.all([
    repo.listCollectionRows(),
    repo.indexInfo(),
    repo.listChanges({ limit: 40 }),
  ]);
  const runner = getRunnerStatus();
  const { getSchedulerStatus } = await import("@/server/scheduler");
  const scheduler = getSchedulerStatus();
  return {
    configured: storeReady(),
    demo: demoMode(),
    collections: rows.map(view),
    index: { products: info.products, lastSeen: info.lastSeen?.toISOString() ?? null },
    runner: {
      running: runner.running,
      progress: runner.progress,
      queued: runner.queued.length,
      lastCheckAt: runner.lastCheckAt ? new Date(runner.lastCheckAt).toISOString() : null,
      lastFullAt: runner.lastFullAt ? new Date(runner.lastFullAt).toISOString() : null,
      lastError: runner.lastError,
      incremental: runner.incremental,
      everyMinutes: scheduler.collectionsEveryMinutes,
      scheduled: scheduler.enabled,
      maxChanges: maxChanges(),
      lastMoved: runner.lastMoved,
      timeZone: scheduler.timeZone,
    },
    changes: changes.map(changeView),
  };
}

/** The store's own terms, and the attributes its products carry, for the rule editor. */
export async function loadOptions(): Promise<CollectionOptions> {
  const client = await woo();
  const [categories, tags, brands, attributes, rows] = await Promise.all([
    client.listCategories(),
    client.listTags(),
    client.listBrands().catch(() => []),
    repo.attributeOptions(),
    repo.listCollectionRows(),
  ]);
  const owner = new Map(rows.map((r) => [r.termId, r.id]));
  return {
    categories: termOptions(categories).map((c) => ({ ...c, collectionId: owner.get(c.id) ?? null })),
    tags: termOptions(tags),
    brands: termOptions(brands),
    attributes,
  };
}

export async function loadState(): Promise<CollectionsState> {
  const status = await loadStatus();
  if (!status.configured) return { ...status, options: null, optionsError: null };
  try {
    return { ...status, options: await loadOptions(), optionsError: null };
  } catch (e) {
    return { ...status, options: null, optionsError: e instanceof Error ? e.message : String(e) };
  }
}

/** On opening the editor: an empty index is read whole, a stale one brought up to date. */
export async function freshen(): Promise<void> {
  if (!storeReady()) return;
  const info = await repo.indexInfo();
  if (info.products === 0) {
    requestFullRead();
    return;
  }
  const runner = getRunnerStatus();
  const last = runner.lastCheckAt ?? runner.lastFullAt ?? 0;
  if (Date.now() - last > 2 * 60_000) requestCheck();
}

/** The automatic categories behind these category ids, for the Vetrina's rails. */
export async function collectionsByTerm(): Promise<Record<number, RailCollection>> {
  const rows = await repo.listCollectionRows();
  const out: Record<number, RailCollection> = {};
  for (const r of rows) {
    out[r.termId] = {
      id: r.id,
      enabled: r.enabled,
      match: r.match,
      conditions: r.conditions,
      members: r.members,
      held: r.held ?? null,
      lastError: r.lastError,
    };
  }
  return out;
}

/** The rule editor opened on one category (the Vetrina's sheet): its rule, if any, and the choices. */
export async function loadForTerm(termId: number): Promise<TermEditor> {
  const [rows, options, info] = await Promise.all([repo.listCollectionRows(), loadOptions(), repo.indexInfo()]);
  await freshen();
  const row = rows.find((r) => r.termId === termId);
  return {
    view: row ? view(row) : null,
    options,
    indexProducts: info.products,
    demo: demoMode(),
  };
}

/* ---------------------------------------------------------------- *
 * Checking and saving a draft
 * ---------------------------------------------------------------- */

/**
 * A tag that does not exist yet ("saldi", to be created on save) is one no
 * product carries: checked and previewed as an id no store will ever give out.
 */
const UNBORN_TAG = String(2 ** 31 - 1);
/** The category of a collection whose category is still to be created. */
const UNBORN_CATEGORY = -1;

async function evalContext(client: WooClient): Promise<{ ctx: EvalContext; categories: Term[]; tags: Term[]; brands: Term[] }> {
  const [categories, tags, brands] = await Promise.all([
    client.listCategories(),
    client.listTags(),
    client.listBrands().catch(() => [] as Term[]),
  ]);
  return {
    ctx: { now: Date.now(), categoryParents: parentsOf(categories), brandParents: parentsOf(brands) },
    categories,
    tags,
    brands,
  };
}

const sameName = (a: string, b: string) => decodeEntities(a).trim().toLowerCase() === b.trim().toLowerCase();

/** A tag condition naming a tag that is not on the store yet (to be created on save). */
const unbornTag = (c: CollectionCondition) => c.field === "tag" && !c.value.trim() && !!c.label?.trim();

/**
 * Put every term condition in its final shape: a tag typed by name gets the
 * id of the tag of that name when there is one, and every term condition the
 * name the store gives it now (the rule's words read right after a rename).
 */
function settle(conditions: CollectionCondition[], terms: { tags: Term[]; brands: Term[]; categories: Term[] }): CollectionCondition[] {
  const named = { tag: paths(terms.tags), brand: paths(terms.brands), category: paths(terms.categories) };
  return conditions.map((c) => {
    if (FIELD_VALUE[c.field] !== "term") return { ...c, value: c.value.trim(), label: c.label?.trim() || undefined };
    const field = c.field as keyof typeof named;
    if (unbornTag(c)) {
      const found = terms.tags.find((t) => sameName(t.name, c.label!));
      return found ? { ...c, value: String(found.id), label: decodeEntities(found.name) } : c;
    }
    const id = Number(c.value);
    const label = named[field].get(id);
    return label ? { ...c, label } : c;
  });
}

function asCollection(draft: CollectionDraft, conditions: CollectionCondition[], name: string): SmartCollection {
  return {
    id: draft.id ?? "draft",
    termId: draft.termId ?? UNBORN_CATEGORY,
    name,
    match: draft.match,
    conditions,
    enabled: draft.enabled,
  };
}

/**
 * What is wrong with a draft, and what saving it would do to its category —
 * decided over the store index exactly as the runs decide it.
 */
export async function checkDraft(draft: CollectionDraft): Promise<DraftCheck> {
  const client = await woo();
  const { ctx, categories, tags, brands } = await evalContext(client);
  const conditions = settle(draft.conditions, { tags, brands, categories }).map((c) =>
    unbornTag(c) ? { ...c, value: UNBORN_TAG } : c,
  );
  const name = draft.newCategory?.name ?? categories.find((c) => c.id === draft.termId)?.name ?? "";
  const collection = asCollection(draft, conditions, decodeEntities(name));
  const saved = (await repo.listCollectionRows()).map(repo.toCollection);
  const problems: DraftProblem[] = [];
  if (!draft.termId && !draft.newCategory) problems.push({ kind: "noCategory" });
  problems.push(...ruleProblems(collection, saved.filter((c) => c.id !== draft.id), ctx.categoryParents));
  const products = await repo.readIndex();
  return { problems, preview: previewCollection(products, saved, collection, ctx) };
}

/**
 * Save a draft — creating its category, and any tag it names that the store
 * does not have yet — and, when it is on, apply it at once: saving IS the
 * confirmation, the preview having shown what it would do.
 */
export async function saveDraft(draft: CollectionDraft): Promise<string> {
  const client = await woo();
  const { ctx, categories, tags, brands } = await evalContext(client);
  const saved = (await repo.listCollectionRows()).map(repo.toCollection);
  const previous = draft.id ? saved.find((c) => c.id === draft.id) : undefined;
  if (draft.id && !previous) throw new CollectionError("not_found", "This automatic category no longer exists.");

  // The rule is checked BEFORE anything is created on the store.
  let conditions = settle(draft.conditions, { tags, brands, categories });
  const checked = conditions.map((c) => (unbornTag(c) ? { ...c, value: UNBORN_TAG } : c));
  const probe = asCollection(draft, checked, "");
  if (!draft.termId && !draft.newCategory) throw new CollectionError("invalid", "Choose the category to fill.");
  const problems = ruleProblems(probe, saved.filter((c) => c.id !== draft.id), ctx.categoryParents);
  if (problems.length > 0) throw new CollectionError("invalid", `The rule cannot be saved (${problems[0].kind}).`);

  let termId = draft.termId;
  let name = categories.find((c) => c.id === termId)?.name ?? "";
  if (!termId && draft.newCategory) {
    const wanted = draft.newCategory.name.trim();
    const parent = draft.newCategory.parent || 0;
    const existing = categories.find((c) => (c.parent ?? 0) === parent && sameName(c.name, wanted));
    const created = existing ?? (await client.createCategory(wanted, parent || undefined));
    if (!created) throw new CollectionError("store", "The store did not create the category (check the key's permissions).");
    termId = created.id;
    name = created.name;
  }
  if (!termId) throw new CollectionError("invalid", "Choose the category to fill.");

  for (const [i, c] of conditions.entries()) {
    if (!unbornTag(c)) continue;
    const created = (await client.createTag(c.label!.trim())) ?? (await client.listTags()).find((t) => sameName(t.name, c.label!));
    if (!created) throw new CollectionError("store", `The store did not create the tag «${c.label}».`);
    conditions = conditions.map((x, j) => (j === i ? { ...x, value: String(created.id), label: decodeEntities(created.name) } : x));
  }

  const input = { termId, name: decodeEntities(name), match: draft.match, conditions, enabled: draft.enabled };
  const row = previous ? await repo.updateCollection(previous.id, input) : await repo.insertCollection(input);
  if (!row) throw new CollectionError("not_found", "This automatic category no longer exists.");
  if (row.enabled) requestApply(row.id);
  return row.id;
}

export async function pauseCollection(id: string, paused: boolean): Promise<void> {
  if (!(await repo.getCollectionRow(id))) throw new CollectionError("not_found", "This automatic category no longer exists.");
  await repo.setCollectionEnabled(id, !paused);
  if (!paused) requestApply(id);
}

/**
 * Stop managing a category. Its products stay where they are — the category
 * simply goes back to being filled by hand.
 */
export async function removeCollection(id: string): Promise<void> {
  await repo.deleteCollection(id);
}

/** A change the automatic runs held back, confirmed by hand. */
export async function confirmCollection(id: string): Promise<void> {
  if (!(await repo.getCollectionRow(id))) throw new CollectionError("not_found", "This automatic category no longer exists.");
  requestApply(id);
}

export async function readAgain(): Promise<void> {
  await woo();
  requestFullRead();
}

/* ---------------------------------------------------------------- *
 * One product's tags
 * ---------------------------------------------------------------- */

const asOption = (t: { id: number; name: string }): TermOption => ({ id: t.id, name: t.name, path: t.name });

/** A product's tags as the store has them now (read live), and every tag to choose from. */
export async function productTags(productId: number): Promise<ProductTagsView> {
  const client = await woo();
  const [{ products }, tags, rows] = await Promise.all([
    client.getProductIndexPage({ page: 1, perPage: 1, include: [productId] }),
    client.listTags(),
    repo.listCollectionRows(),
  ]);
  const product = products[0];
  if (!product) throw new CollectionError("not_found", "The store has no such product.");
  const row = toIndexRow(product);
  await repo.upsertIndexRows([row]);
  return {
    tags: row.tags.map(asOption),
    available: termOptions(tags),
    inCollections: rows.filter((r) => row.categories.some((c) => c.id === r.termId)).map((r) => r.name),
  };
}

/** Save a product's tags; its automatic categories follow at once (see setProductTags). */
export async function saveProductTags(productId: number, tags: { id?: number; name: string }[]): Promise<ProductTagsResult> {
  await woo();
  const edit = await setProductTags(productId, tags);
  return { ...edit, tags: edit.tags.map(asOption) };
}
