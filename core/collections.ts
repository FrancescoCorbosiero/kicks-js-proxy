/**
 * collections.ts
 * -----------------------------------------------------------------------------
 * Automatic categories ("smart collections"): WooCommerce categories that fill
 * and empty themselves.
 *
 * Shopify's automated collections, on WooCommerce. A collection is a product
 * category plus a rule — "tag is saldi", "brand is Nike and in stock" — and the
 * category's members are exactly the products the rule matches: a product that
 * starts matching joins, one that stops matching leaves, whoever put it there.
 * The shop assigns tags, brands and attributes wherever it likes (WP admin, the
 * Hub, the Vetrina), and everything built on the category follows: its archive
 * page, the homepage rail that shows it, a menu.
 *
 * The category stays a REAL category on the store — the membership is written
 * there, not computed at render time — so every page, filter, sitemap and feed
 * that reads categories sees it, with no plugin involved.
 *
 * Pure module: no HTTP, no DB. The runner (src/server/collections) feeds it the
 * store's products as indexed rows and writes back what it decides.
 */

/* ------------------------------------------------------------------ */
/* THE RULE VOCABULARY                                                 */
/* ------------------------------------------------------------------ */

/**
 * What a condition looks at. The taxonomies come first — they are the point:
 * the shop assigns a tag and the category follows — then a few facts of the
 * product itself, the ones a homepage rail is usually about (on sale, new, in
 * stock, under a price).
 */
export const CONDITION_FIELDS = [
    "tag",
    "brand",
    "category",
    "attribute",
    "title",
    "price",
    "onSale",
    "inStock",
    "created",
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_OPS = [
    "is",
    "isNot",
    "contains",
    "notContains",
    "gt",
    "lt",
    "withinDays",
    "olderThanDays",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** The operators each field takes; the first is the default. */
export const FIELD_OPS: Record<ConditionField, readonly ConditionOp[]> = {
    tag: ["is", "isNot"],
    brand: ["is", "isNot"],
    category: ["is", "isNot"],
    attribute: ["is", "isNot"],
    title: ["contains", "notContains"],
    price: ["gt", "lt"],
    onSale: ["is", "isNot"],
    inStock: ["is", "isNot"],
    created: ["withinDays", "olderThanDays"],
};

/**
 * The kind of value a field takes: a store term (by id), an attribute option,
 * free text, a number, or nothing at all (a yes/no fact).
 */
export type ValueKind = "term" | "option" | "text" | "number" | "none";

export const FIELD_VALUE: Record<ConditionField, ValueKind> = {
    tag: "term",
    brand: "term",
    category: "term",
    attribute: "option",
    title: "text",
    price: "number",
    onSale: "none",
    inStock: "none",
    created: "number",
};

export interface CollectionCondition {
    field: ConditionField;
    op: ConditionOp;
    /**
     * Tag / brand / category: the term's ID — never its slug or name, so a term
     * renamed in WP admin keeps its collections. Attribute: the option ("Uomo").
     * Title: the text. Price: a number ("99,90" is read too). Created: days.
     * Yes/no facts (on sale, in stock): "".
     */
    value: string;
    /** Attribute conditions only: which attribute (see attributeKey). */
    attribute?: string;
    /**
     * The value's name when it was chosen ("Saldi"), so the rule still reads
     * in words when the term is gone from the store.
     */
    label?: string;
}

export interface SmartCollection {
    id: string;
    /** The product_cat term whose members this collection decides. */
    termId: number;
    /** The category's name, for display. */
    name: string;
    /** Every condition must hold ("all"), or at least one ("any"). */
    match: "all" | "any";
    conditions: CollectionCondition[];
    /** Off = paused: nothing joins, nothing leaves, the category stays as it is. */
    enabled: boolean;
}

/* ------------------------------------------------------------------ */
/* THE STORE, AS THE RULES SEE IT                                      */
/* ------------------------------------------------------------------ */

export interface IndexedTerm {
    id: number;
    slug: string;
    name: string;
}

export interface IndexedAttribute {
    /** See attributeKey: "id:3" for a global attribute, "name:colore" for a product's own. */
    key: string;
    name: string;
    options: string[];
}

/** One store product: its taxonomies and the few facts a rule can read. */
export interface IndexedProduct {
    id: number;
    sku: string;
    name: string;
    status: string;
    categories: IndexedTerm[];
    tags: IndexedTerm[];
    brands: IndexedTerm[];
    attributes: IndexedAttribute[];
    /** The current price (the lowest, for a product with sizes); null when it has none. */
    price: number | null;
    onSale: boolean;
    /** "instock" | "outofstock" | "onbackorder" ("" when unknown). */
    stockStatus: string;
    /** When the product was created (ISO), null when unknown. */
    dateCreated: string | null;
}

/**
 * How an attribute is named in a rule. A global attribute (pa_gender) by its
 * id, which survives a rename of its label; a product's own attribute, which
 * has no id, by its name.
 */
export function attributeKey(id: number | null | undefined, name: string): string {
    return id != null && id > 0 ? `id:${id}` : `name:${norm(name)}`;
}

/** term id → its parent's id (0 or absent = top level), for one hierarchical taxonomy. */
export type TermParents = ReadonlyMap<number, number>;

export interface EvalContext {
    /** "Now", for the age of a product (epoch ms). */
    now: number;
    /** The category tree: "in category X" includes X's sub-categories. */
    categoryParents: TermParents;
    /** The brand tree: "brand is Nike" includes Nike Off-White. */
    brandParents: TermParents;
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
const DAY_MS = 86_400_000;

/** A term and every ancestor above it. Bounded, so a loop in bad data cannot hang. */
export function withAncestors(ids: Iterable<number>, parents: TermParents): Set<number> {
    const out = new Set<number>();
    for (const start of ids) {
        let id = start;
        for (let depth = 0; id > 0 && !out.has(id) && depth < 64; depth++) {
            out.add(id);
            id = parents.get(id) ?? 0;
        }
    }
    return out;
}

/** "99,90" or "99.90" → 99.9; anything else → NaN. */
export function parseNumber(value: string): number {
    const text = value.trim().replace(",", ".");
    return text === "" ? Number.NaN : Number(text);
}

function termId(value: string): number {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/* ------------------------------------------------------------------ */
/* MATCHING                                                            */
/* ------------------------------------------------------------------ */

/**
 * A product while the collections decide about it: its categories change as
 * each collection has its say, and a later collection's rule reads them as
 * they are by then.
 */
interface ProductView {
    product: IndexedProduct;
    categoryIds: ReadonlySet<number>;
}

/** The positive reading of a condition; isNot / notContains negate it. */
function holds(c: CollectionCondition, view: ProductView, ctx: EvalContext): boolean {
    const p = view.product;
    switch (c.field) {
        case "tag": {
            const id = termId(c.value);
            return id > 0 && p.tags.some((t) => t.id === id);
        }
        case "brand": {
            const id = termId(c.value);
            return id > 0 && withAncestors(p.brands.map((b) => b.id), ctx.brandParents).has(id);
        }
        case "category": {
            const id = termId(c.value);
            return id > 0 && withAncestors(view.categoryIds, ctx.categoryParents).has(id);
        }
        case "attribute": {
            const wanted = norm(c.value);
            const attribute = p.attributes.find((a) => a.key === c.attribute);
            return wanted !== "" && !!attribute && attribute.options.some((o) => norm(o) === wanted);
        }
        case "title": {
            const needle = norm(c.value);
            return needle !== "" && norm(p.name).includes(needle);
        }
        case "price": {
            const limit = parseNumber(c.value);
            if (p.price == null || !Number.isFinite(limit)) return false;
            return c.op === "gt" ? p.price > limit : p.price < limit;
        }
        case "onSale":
            return p.onSale;
        case "inStock":
            // Back-orderable is buyable: it belongs in "available".
            return p.stockStatus === "instock" || p.stockStatus === "onbackorder";
        case "created": {
            const days = parseNumber(c.value);
            const created = p.dateCreated ? Date.parse(p.dateCreated) : Number.NaN;
            if (!Number.isFinite(days) || !Number.isFinite(created)) return false;
            const age = (ctx.now - created) / DAY_MS;
            return c.op === "withinDays" ? age <= days : age > days;
        }
    }
}

const NEGATING: ReadonlySet<ConditionOp> = new Set(["isNot", "notContains"]);

export function conditionMatches(c: CollectionCondition, view: ProductView, ctx: EvalContext): boolean {
    const positive = holds(c, view, ctx);
    return NEGATING.has(c.op) ? !positive : positive;
}

/** True when the product belongs in the collection. A rule with no conditions matches nothing. */
export function collectionMatches(
    collection: Pick<SmartCollection, "match" | "conditions">,
    view: ProductView,
    ctx: EvalContext,
): boolean {
    if (collection.conditions.length === 0) return false;
    return collection.match === "all"
        ? collection.conditions.every((c) => conditionMatches(c, view, ctx))
        : collection.conditions.some((c) => conditionMatches(c, view, ctx));
}

/* ------------------------------------------------------------------ */
/* ORDER, LOOPS, AND RULES THAT READ THEMSELVES                        */
/* ------------------------------------------------------------------ */

/** The categories a rule reads ("category is X" / "is not X"). */
function readCategories(collection: Pick<SmartCollection, "conditions">): number[] {
    return collection.conditions
        .filter((c) => c.field === "category")
        .map((c) => termId(c.value))
        .filter((id) => id > 0);
}

/**
 * Does `reader`'s rule depend on who is in `target`'s category? "Category is
 * X" holds for X and every sub-category, so it depends on every collection
 * whose category is X or sits below it.
 */
function readsCategoryOf(
    reader: Pick<SmartCollection, "conditions">,
    target: Pick<SmartCollection, "termId">,
    parents: TermParents,
): boolean {
    const affected = withAncestors([target.termId], parents);
    return readCategories(reader).some((id) => affected.has(id));
}

/**
 * A rule that reads its own category can never settle: "in Saldi" keeps
 * whatever got in, "not in Saldi" lets a product in and out on every run.
 * Reading a parent of its own category is the same thing one level up.
 */
export function readsItself(collection: Pick<SmartCollection, "termId" | "conditions">, parents: TermParents): boolean {
    return readsCategoryOf(collection, collection, parents);
}

/** True when `start` reads, directly or through others in `among`, its own category. */
function inLoop(start: SmartCollection, among: Map<string, SmartCollection>, parents: TermParents): boolean {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const other of among.values()) {
            if (!readsCategoryOf(current, other, parents)) continue;
            if (other.id === start.id) return true;
            if (!seen.has(other.id)) {
                seen.add(other.id);
                stack.push(other);
            }
        }
    }
    return false;
}

/**
 * The order collections are decided in: one whose rule reads another's
 * category comes after it, so it sees that category as it WILL be. The ones
 * caught in a loop (A reads B, B reads A — or a rule reading itself) cannot be
 * decided at all and are returned apart; whoever reads THEIR category is still
 * decided, against the category as it stands.
 */
export function orderCollections(
    collections: SmartCollection[],
    parents: TermParents,
): { ordered: SmartCollection[]; cyclic: SmartCollection[] } {
    const pending = new Map<string, SmartCollection>();
    const cyclic: SmartCollection[] = [];
    for (const c of collections) {
        if (readsItself(c, parents)) cyclic.push(c);
        else pending.set(c.id, c);
    }
    const ordered: SmartCollection[] = [];
    // Kahn's algorithm, stable: among the ready ones, the given order wins.
    while (pending.size > 0) {
        const ready = [...pending.values()].find((c) =>
            [...pending.values()].every((other) => other.id === c.id || !readsCategoryOf(c, other, parents)),
        );
        if (ready) {
            ordered.push(ready);
            pending.delete(ready.id);
            continue;
        }
        // Stuck: what is left reads something still undecided. Set the loops
        // aside; what only waited on them is decidable now.
        const looping = [...pending.values()].filter((c) => inLoop(c, pending, parents));
        if (looping.length === 0) break; // cannot happen — a stall means a loop
        for (const c of looping) {
            cyclic.push(c);
            pending.delete(c.id);
        }
    }
    return { ordered, cyclic: [...cyclic, ...pending.values()] };
}

/* ------------------------------------------------------------------ */
/* DECIDING                                                            */
/* ------------------------------------------------------------------ */

export interface ProductDecision {
    productId: number;
    /** The categories before, and after every collection has had its say. */
    before: number[];
    after: number[];
    /** Collections (ids) the product joins / leaves. */
    joined: string[];
    left: string[];
}

/**
 * Decide one product against every collection, in order. Collections in
 * `frozen` (paused, held for confirmation, caught in a loop) keep whatever
 * members they have; the ones after them read those as they are.
 *
 * Only the categories the collections manage are ever touched: every other
 * category the product has stays, in its place.
 */
export function decideProduct(
    product: IndexedProduct,
    ordered: SmartCollection[],
    ctx: EvalContext,
    frozen: ReadonlySet<string> = new Set(),
): ProductDecision {
    const before = product.categories.map((c) => c.id);
    const current = new Set(before);
    const joined: string[] = [];
    const left: string[] = [];
    for (const collection of ordered) {
        if (!collection.enabled || frozen.has(collection.id)) continue;
        const member = collectionMatches(collection, { product, categoryIds: current }, ctx);
        const inside = current.has(collection.termId);
        if (member && !inside) {
            current.add(collection.termId);
            joined.push(collection.id);
        } else if (!member && inside) {
            current.delete(collection.termId);
            left.push(collection.id);
        }
    }
    const after = before.filter((id) => current.has(id));
    for (const id of current) if (!after.includes(id)) after.push(id);
    return { productId: product.id, before, after, joined, left };
}

export interface CollectionDiff {
    collectionId: string;
    termId: number;
    /** Members now, and once the decision is applied. */
    before: number;
    after: number;
    /** Product ids joining / leaving. */
    joining: number[];
    leaving: number[];
}

/** Why an automatic run leaves a collection alone and asks first. */
export type HoldReason = "empties" | "tooManyChanges";

export interface GuardLimits {
    /** Most products an automatic run may move in or out of one collection. */
    maxChanges: number;
}

/**
 * The automatic runs' safety net. A rule is data, and data breaks: a tag
 * deleted in WP admin, an option renamed, a typo saved by mistake — and the
 * category empties itself on the next run, taking the homepage rail with it.
 * So an automatic run never empties a category, and never moves more than
 * `maxChanges` products at once: either is held until someone confirms it in
 * the Hub. A change made by hand (save, "apply now") is its own confirmation.
 */
export function holdReason(diff: CollectionDiff, limits: GuardLimits): HoldReason | null {
    if (diff.before > 0 && diff.after === 0) return "empties";
    if (diff.joining.length + diff.leaving.length > limits.maxChanges) return "tooManyChanges";
    return null;
}

export interface CollectionsPlan {
    /** Collections in the order they were decided. */
    ordered: SmartCollection[];
    /** Collections caught in a loop: left alone. */
    cyclic: SmartCollection[];
    /** Collections an automatic run holds for confirmation: why, and what it would have changed. */
    held: Map<string, { reason: HoldReason; diff: CollectionDiff }>;
    /** Per collection (enabled, decided ones): who joins and who leaves. */
    diffs: Map<string, CollectionDiff>;
    /** Only the products whose categories change. */
    changed: ProductDecision[];
}

export interface PlanOptions {
    /** Apply the safety net (automatic runs). Off: every collection is decided as asked. */
    limits?: GuardLimits;
    /** Collections whose change was confirmed by hand: never held. */
    confirmed?: ReadonlySet<string>;
}

function decideAll(
    products: IndexedProduct[],
    ordered: SmartCollection[],
    ctx: EvalContext,
    frozen: ReadonlySet<string>,
): { diffs: Map<string, CollectionDiff>; changed: ProductDecision[] } {
    const diffs = new Map<string, CollectionDiff>();
    for (const c of ordered) {
        if (!c.enabled || frozen.has(c.id)) continue;
        diffs.set(c.id, { collectionId: c.id, termId: c.termId, before: 0, after: 0, joining: [], leaving: [] });
    }
    const changed: ProductDecision[] = [];
    for (const product of products) {
        const decision = decideProduct(product, ordered, ctx, frozen);
        for (const diff of diffs.values()) {
            if (decision.before.includes(diff.termId)) diff.before += 1;
            if (decision.after.includes(diff.termId)) diff.after += 1;
        }
        for (const id of decision.joined) diffs.get(id)?.joining.push(product.id);
        for (const id of decision.left) diffs.get(id)?.leaving.push(product.id);
        if (decision.joined.length > 0 || decision.left.length > 0) changed.push(decision);
    }
    return { diffs, changed };
}

/**
 * Decide every product against every collection. With limits (an automatic
 * run), a collection the safety net catches is frozen and the rest decided
 * again.
 *
 * Only the first offenders along the order are held in a round: a collection
 * reading a held one's category was judged on a change that is not going to
 * happen — "Outlet = in Saldi" empties only BECAUSE Saldi would — so it is
 * judged again against the category as it stands, in the next round.
 */
export function planCollections(
    products: IndexedProduct[],
    collections: SmartCollection[],
    ctx: EvalContext,
    options: PlanOptions = {},
): CollectionsPlan {
    const enabled = collections.filter((c) => c.enabled);
    const { ordered, cyclic } = orderCollections(enabled, ctx.categoryParents);
    const frozen = new Set<string>(cyclic.map((c) => c.id));
    const held: CollectionsPlan["held"] = new Map();
    // Each round holds at least one more collection, so this ends.
    for (;;) {
        const { diffs, changed } = decideAll(products, ordered, ctx, frozen);
        if (!options.limits) return { ordered, cyclic, held, diffs, changed };
        const judgedOnAChangeThatWontHappen: SmartCollection[] = [];
        let more = false;
        for (const c of ordered) {
            if (frozen.has(c.id)) continue;
            if (judgedOnAChangeThatWontHappen.some((h) => readsCategoryOf(c, h, ctx.categoryParents))) {
                judgedOnAChangeThatWontHappen.push(c);
                continue;
            }
            const diff = diffs.get(c.id);
            if (!diff || options.confirmed?.has(c.id)) continue;
            const reason = holdReason(diff, options.limits);
            if (!reason) continue;
            held.set(c.id, { reason, diff });
            frozen.add(c.id);
            judgedOnAChangeThatWontHappen.push(c);
            more = true;
        }
        if (!more) return { ordered, cyclic, held, diffs, changed };
    }
}

/* ------------------------------------------------------------------ */
/* WHAT A RULE WOULD DO                                                */
/* ------------------------------------------------------------------ */

export interface PreviewProduct {
    id: number;
    sku: string;
    name: string;
}

export interface CollectionPreview {
    /** Members now, and once the rule is applied. */
    before: number;
    after: number;
    joiningCount: number;
    leavingCount: number;
    /** The first few of each, by name — enough to check the numbers at a glance. */
    joining: PreviewProduct[];
    leaving: PreviewProduct[];
    members: PreviewProduct[];
    /**
     * Leaving products that would have no category left at all. WooCommerce
     * files those under its default category ("Senza categoria"), which is
     * worth knowing before it happens.
     */
    orphaned: number;
}

const byName = (a: PreviewProduct, b: PreviewProduct) =>
    a.name.localeCompare(b.name, "it", { sensitivity: "base" }) || a.id - b.id;

/**
 * What saving `draft` would do to its category, decided exactly as the runs
 * decide it — every other collection included, since the draft may read their
 * categories — and with nothing held: saving is its own confirmation.
 */
export function previewCollection(
    products: IndexedProduct[],
    saved: SmartCollection[],
    draft: SmartCollection,
    ctx: EvalContext,
    sample = 12,
): CollectionPreview {
    const asked = { ...draft, enabled: true };
    const plan = planCollections(products, [...saved.filter((c) => c.id !== draft.id), asked], ctx);
    const decided = new Map(plan.changed.map((d) => [d.productId, d]));
    const card = (p: IndexedProduct): PreviewProduct => ({ id: p.id, sku: p.sku, name: p.name });

    const joining: PreviewProduct[] = [];
    const leaving: PreviewProduct[] = [];
    const members: PreviewProduct[] = [];
    let before = 0;
    let orphaned = 0;
    for (const p of products) {
        const decision = decided.get(p.id);
        const after = decision?.after ?? p.categories.map((c) => c.id);
        if (p.categories.some((c) => c.id === draft.termId)) before += 1;
        if (after.includes(draft.termId)) members.push(card(p));
        if (decision?.joined.includes(draft.id)) joining.push(card(p));
        if (decision?.left.includes(draft.id)) {
            leaving.push(card(p));
            if (after.length === 0) orphaned += 1;
        }
    }
    return {
        before,
        after: members.length,
        joiningCount: joining.length,
        leavingCount: leaving.length,
        joining: joining.sort(byName).slice(0, sample),
        leaving: leaving.sort(byName).slice(0, sample),
        members: members.sort(byName).slice(0, sample),
        orphaned,
    };
}

/* ------------------------------------------------------------------ */
/* CHECKING A RULE BEFORE IT IS SAVED                                  */
/* ------------------------------------------------------------------ */

export type RuleProblem =
    | { kind: "noConditions" }
    | { kind: "badValue"; index: number }
    | { kind: "badOperator"; index: number }
    | { kind: "readsItself"; index: number }
    | { kind: "loop"; with: string[] }
    | { kind: "categoryTaken"; by: string };

/**
 * What is wrong with a rule, in terms the editor can point at. Empty when it
 * can be saved. `others` are the collections already saved (the draft itself
 * excluded): a category belongs to one collection, and a rule may not close a
 * loop with theirs.
 */
export function ruleProblems(
    draft: SmartCollection,
    others: SmartCollection[],
    parents: TermParents,
): RuleProblem[] {
    const problems: RuleProblem[] = [];
    if (draft.conditions.length === 0) problems.push({ kind: "noConditions" });
    draft.conditions.forEach((c, index) => {
        if (!FIELD_OPS[c.field]?.includes(c.op)) {
            problems.push({ kind: "badOperator", index });
            return;
        }
        const kind = FIELD_VALUE[c.field];
        const value = c.value.trim();
        const bad =
            (kind === "term" && termId(value) === 0) ||
            (kind === "option" && (value === "" || !c.attribute)) ||
            (kind === "text" && value === "") ||
            (kind === "number" && !(parseNumber(value) >= 0));
        if (bad) {
            problems.push({ kind: "badValue", index });
            return;
        }
        if (c.field === "category" && withAncestors([draft.termId], parents).has(termId(value))) {
            problems.push({ kind: "readsItself", index });
        }
    });
    const owner = others.find((o) => o.termId === draft.termId && o.id !== draft.id);
    if (owner) problems.push({ kind: "categoryTaken", by: owner.name });
    if (draft.enabled && !problems.some((p) => p.kind === "readsItself")) {
        const all = [...others.filter((o) => o.id !== draft.id && o.enabled), draft];
        const { cyclic } = orderCollections(all, parents);
        if (cyclic.some((c) => c.id === draft.id)) {
            const partners = cyclic.filter(
                (c) => c.id !== draft.id && (readsCategoryOf(draft, c, parents) || readsCategoryOf(c, draft, parents)),
            );
            problems.push({ kind: "loop", with: partners.map((c) => c.name) });
        }
    }
    return problems;
}
