# Vetrina — the customer's homepage hub (design + spec, draft v0)

Status: **brainstorm + technical spec draft. Nothing agreed, nothing implemented.**
Answer the numbered questions in [§9](#9-decisions-needed) (the number is enough).
Each one has a recommended default. When every blocking question has an answer,
this becomes "agreed direction", like [`catalog-centric-redesign.md`](catalog-centric-redesign.md).

Missing input: the reference image mentioned in the request did not come through (Q1).

Repositories involved:

- **this one** (Store Hub): new customer area, mirror, pricing-engine extension.
- **`golden-hive-blocks`**: renders the homepage rails. Needs a small extension ([§7.2](#72-golden-hive-blocks-extension)).
- **`golden-hive-plugin`** (Hive Commerce admin): read for context only, no change planned.

---

## 0. TL;DR

- The customer gets a new area, **Vetrina**. It shows the homepage section by section,
  exactly as the site shows it. They tap a section to reorder, add or remove products,
  set prices and locks, and set the section's margin. The current developer UI stays as
  it is, and the customer can't reach it.
- **A section is a Woo term**: a `product_cat` category or a `product_brand` brand. The
  homepage already works this way: every rail is `[gh_product_rail category=… | brand=…]`.
  Which products belong to a section stays in WooCommerce.
- **Ordering is the hard part, and it is a storefront limitation, not a UI one.** The
  rails sort by `menu_order` then title. `menu_order` is **one number per product**,
  shared by every rail and every category page. So a product in both "Tendenza" and
  "Nike Air Force 1" can't be #1 in one and #12 in the other.
  - **Recommendation:** store a list of pinned products per section as term meta. The
    rail query and category pages honour it. That's about 150–250 lines of PHP in
    `golden-hive-blocks`.
- **Margin × taxonomy** means changes to the existing pricing engine:
  - a new rule scope, `storeCategory` / `storeBrand`;
  - a new precedence tier: SKU rules > section rules > brand/family rules;
  - an explicit priority for products that sit in two sections;
  - the same safety nets as today.

  The Hub also needs a mirror of which products sit in which Woo terms. Today's pull
  throws that information away.
- Every write to the site goes through one explicit button that states what it will
  do. Every write is logged, with a one-click revert.
- There are 27 questions in §9. 15 of them block a phase, and 6 of those block phase 1.

---

## 1. What exists today

### 1.1 The homepage (audited from its block markup)

| # | Block | What shows | Driven by | Limit |
|---|---|---|---|---|
| 1 | hero-carousel | 5 slides (AP×Swatch, Nike Mind, Jacquemus, Travis Scott, Corteiz) | static attrs | — |
| 2 | trust-badges | 5 badges | static | — |
| 3 | Hustle embed | newsletter | Hustle | — |
| 4 | **rail** | PRODOTTI IN TENDENZA · *Selezione Esclusiva* | `product_cat` `featured-sneakers-originali-streetwear` | 18 |
| 5 | **rail** | SALDI · *Saldi primaverili* | `product_cat` `saldi-sneakers-outlet` | 18 |
| 6 | **rail** | SNEAKERS · *Offerte speciale* | `product_cat` `saldi-sneakers-in-offerta` | 18 |
| 7 | category-slider | 7 cards | static attrs | — |
| 8 | **rail** | NUOVI ARRIVI · *Release aggiornate* | `product_cat` `new-nuove-release` | 18 |
| 9 | **rail** | Nike Off-White · *Design Milanese* | `product_brand` `nike-off-white` | 15 |
| 10 | **rail** | Nike Air Force 1 · *Il classico incontra l'hype* | `product_brand` `nike-air-force-1` | 15 |
| 11 | brand-marquee | 7 logos | static | — |
| 12 | **rail** | ADIDAS | `product_brand` `adidas` (+ sub-brands) | 15 |
| 13 | **rail** | NEW BALANCE | `product_brand` `new-balance` | 15 |
| 14 | **rail** | ASICS | `product_brand` `asics` | 15 |
| 15+ | faq, social, social-proof, whatsapp | static | — | — |

That's **9 product rails and 147 product slots**, in two kinds:

- **Curated** (the 4 category rails): merchandising lists. Someone decides what's in
  them by assigning the category.
- **Factual** (the 5 brand rails): what's in them is the product's brand. The only
  choices are order and, maybe, hiding a product.

### 1.2 How a rail picks and orders products

The code path is `[gh_product_rail]` → `ghb_get_carousel_products()` in
`golden-hive-blocks/includes/product-carousel-shortcode.php`.

- **Membership**: the product is in the term, matched by slug.
  - `category` queries `product_cat`.
  - `brand` queries whichever of `product_brand` / `pwb-brand` / `pa_brand` holds the
    slug, with `include_children`. So the ADIDAS rail includes every adidas sub-brand.
  - Category rails also include child categories (WordPress's default for hierarchical
    taxonomy queries).
- **Visibility**:
  - `publish` only;
  - `product_visibility` NOT IN `exclude-from-catalog`;
  - plus `outofstock` when WooCommerce's "Hide out of stock items" is on.
- **Order**: every homepage rail sets a category or brand and no metric type. In that
  case the order is **`menu_order ASC, post_title ASC`**.
- **Count**: the first `limit` products left after the filters above.
- `ids="…"` is supported (the order is the list itself) but unused. Using it would turn
  the rail into a closed list.

So the order the customer wants to control is **`wp_posts.menu_order`**:

- It is one integer per product, shared by every rail and every category or brand page.
  Category and brand pages use it too, under "Default sorting (custom ordering + name)".
- Two things write it today: the Hive Commerce sorter (`golden-hive-plugin`,
  `includes/bulk/sorter.php`, in steps of 10) and drag-and-drop in WP admin.
- New products get `menu_order = 0`. Once the others are numbered 10, 20, 30…, every new
  product jumps to the top of every rail it belongs to.

Verified in WooCommerce trunk: the REST API reads and writes `menu_order`, accepts
`orderby=menu_order`, returns `brands`, and supports `modified_after`.

### 1.3 Store Hub: what we reuse

| Piece | Where | Role in the Vetrina |
|---|---|---|
| Pricing engine: scoped rules, whole-margin takeover, safety nets | `core/config.ts`, `core/core-spine.ts` | extended with a store-taxonomy scope (§6) |
| Price locks: `store_overrides`, keyed `SKU::EU size`, lock-all / unlock-all | `src/server/overrides/*`, `ProductDrawer` | used as is |
| Drawer data: ask, proposed price, applied rule, locks, live view of store-only products | `src/components/catalog/drawer-data.ts` | data source for the customer's product panel |
| Sync on a SKU subset: `startStoreSync(market, skus)` → `advanceStoreSync` → `applySync({ priceScope: "all", dryRun: false, sanitize: false })` | `src/server/actions/preview.ts`, `src/server/woo/apply.ts` | "publish this product's / this section's prices now" |
| Direct store edits for store-only variations | `src/server/actions/store-edit.ts` | used as is; add simple products |
| Woo client: brand/category listing, product create/update, `brands: [{id}]` | `src/server/woo/client.ts`, `publish-plan.ts` | membership writes, term reads |
| Site guard: refuses to write with another shop's snapshot | `src/server/woo/site-guard.ts` | called by every new write path |
| i18n, Italian as source of truth | `src/i18n/*` | all new copy |

### 1.4 Store Hub: gaps

1. **The Hub has no store taxonomy.**
   - `toStoreProduct()` keeps id, sku, name, status, images, attributes and variations.
     It drops `categories`, `brands`, `menu_order`, `featured`, `catalog_visibility`,
     `date_created` and `total_sales`.
   - The catalog's `category` / `secondaryCategory` are the *catalog's* family tree (from
     KicksDB or the title classifier), not Woo terms.
   - So nothing links a product to "saldi-sneakers-outlet".
2. **The pull only covers `type=variable&status=publish`.** Simple products (a watch, a
   bag) are invisible to the Hub, but they can sit in a rail.
3. **The snapshot is one jsonb blob.** That suits the plan engine, but it can't answer
   queries like "products of term X ordered by Y".
4. **Rules can't target a Woo term.** Scope axes are source, brand, catalog family,
   model, SKU and size.
5. **A lock reaches the store only through a Sync run** (pull → preview → dry run → live).
6. **There is one shared password and one role.** Whoever logs in can run the cleanup
   (which deletes variations), force a reimport, or trash duplicates.
7. **GoldenSneakers products are priced upstream** (`presented_price` plus a zero-markup
   passthrough rule). A Hub margin on top would count the margin twice.

### 1.5 Spotted along the way (small, outside scope)

- The "Esplora le tendenze" button never renders. It has `buttonText` but no
  `buttonUrl`, and the block needs both.
- Copy: the eyebrow says "Saldi primaverili" (spring sales) in autumn, and "Offerte
  speciale" should be "Offerte speciali".
- `social-proof` cycles hardcoded purchases with fixed times ("1 minuto fa").
  - If these aren't real purchases, fabricated purchase notifications are a
    misleading-practice risk under EU and Italian consumer law.
  - The Hub already mirrors real orders (`store_orders`) and could feed real ones.
- The brand marquee hotlinks the Jordan and Timberland logos from upload.wikimedia.org.

---

## 2. The job, restated

The customer is not technical. They want to keep the homepage's products right without
calling you. They need to:

1. See the homepage sections in order, each with its name and first products.
2. Control each section: which products, in which order, at which price, with price locks.
3. Set a margin per section (category or brand). Sneaker prices move, and a sale
   section, a hype brand and a trending list need different margins.
4. Do the same for any other Woo category or brand, beyond the homepage.
5. Stay away from anything dangerous, while the developer keeps the full Hub.

---

## 3. Concept: "Vetrina"

### 3.1 Principles

1. **Mirror the site.** The Vetrina first shows what the homepage shows now: same
   products, same order, same count. Every difference is explained: sold out, hidden,
   or past the end of the homepage rail.
2. **One concept: a section is a Woo category or brand.**
   - Homepage sections are the terms the homepage uses.
   - Every other term lives under "Tutte le categorie / Tutti i marchi".
   - Both use the same editor.
3. **Nothing changes on the site until a yellow button is pressed.**
   - Every button says what it will do: "Pubblica 3 modifiche", "Applica margine a 42
     prodotti".
   - Every publish lands in a history with a "Ripristina" (restore) action.
4. **Plain Italian, no jargon.** "Prezzo bloccato", not "manual override". "Margine
   sezione Saldi 10%", not "rule scope product_cat".
5. **Touch first.** Big targets and long-press drag. Every drag also has a non-drag path
   (type a position number, "In cima").
6. **The old UI stays untouched.** The Vetrina is a new route group. The developer sees
   it as one more tab.

### 3.2 Screens

**A. Vetrina (home)** lists blocks in homepage order.

- Product rails show their name, eyebrow and first products.
- Static blocks show as thin placeholders, so the page still reads like the real one.

```
Vetrina                                     ⟳ aggiornata 2 min fa   [Vedi il sito ↗]
────────────────────────────────────────────────────────────────────────────────
 Hero · 5 slide                                                       (dal sito)
 1  PRODOTTI IN TENDENZA · Selezione Esclusiva      18 in vetrina · margine 30%
    [▢][▢][▢][▢][▢][▢][▢][▢] +10                   ⚠ 2 esauriti nascosti     ›
 2  SALDI · Saldi primaverili                       18 in vetrina · margine 10%
    [▢][▢][▢][▢][▢][▢][▢][▢] +10                                             ›
 3  SNEAKERS · Offerte speciale                     …                          ›
 Slider categorie · 7                                                 (dal sito)
 4  NUOVI ARRIVI · Release aggiornate               …                          ›
 …
```

**B. Section editor** shows the rail as a grid on desktop or a list on a phone. A line
marks where the homepage rail stops.

```
‹ Vetrina   PRODOTTI IN TENDENZA        [Griglia | Lista]    [+ Aggiungi prodotti]
Dopo i fissati: [Ordine del negozio ▾]                    Margine sezione: 30% ✎
┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐
│1 📌││2 📌││3 📌││4   ││5   ││6   │      trascinare = fissare la posizione
└────┘└────┘└────┘└────┘└────┘└────┘
…
════════ fine vetrina: in homepage si vedono i primi 18 ════════
┌────┐┌────┐ …                               (solo nella pagina categoria)
Nascosti dal sito: [▢ esaurito] [▢ esaurito]
╔════════════════════════════════════════════════════════════════════╗
║ 3 modifiche non pubblicate           [Annulla]   [Pubblica sul sito] ║
╚════════════════════════════════════════════════════════════════════╝
```

Each card shows:

- photo, name and "da €189,99";
- 🔒 when any size is locked;
- its position and pin state;
- "anche in: Nike AF1, Saldi" (the other sections it's in).

The card menu offers: In cima · Sposta alla posizione… · In fondo ai fissati · Togli
posizione fissa · Rimuovi dalla sezione · Prezzi…

**C. Tutte le categorie / Tutti i marchi** shows the Woo tree.

- Categories follow the order set in WooCommerce. Brands are alphabetical unless the
  store orders them.
- Each row shows the name, product count, the first 6 thumbnails in storefront order,
  and an "in homepage" badge.
- Each row opens the same editor.

**D. Margini per sezione**

```
Margine sul prezzo di mercato. Se un prodotto è in più sezioni vale quella più in alto.
 ≡  Saldi                     10%     64 prodotti    [Anteprima]
 ≡  Nike Off-White            40%     22 prodotti
 ≡  Prodotti in tendenza      30%     52 prodotti
    Tutto il resto: margine standard (35% → 19% a scaglioni)           🔒 sviluppatore
 ⚠ 9 prodotti sono sia in Saldi che in Tendenza → usano Saldi (10%)
```

**E. Product panel** is a sheet over the page. It shows:

- photo, name, SKU, and where it sits ("in vetrina: Tendenza #3 · Nike AF1 #7");
- the price explained in one line: "Prezzo StockX €140 + margine Saldi 10% → €154,99",
  or "Bloccato da te il 12/09";
- each size with its shelf price, computed price and 🔒. Editing a price locks it;
- "Blocca tutti / Sblocca tutti" and "Salva e pubblica";
- a warning when a locked price is below cost.

### 3.3 Sorting UX: where it has to be smart

1. **The fold line.** The rail's `limit` is drawn in the grid.
2. **Pinned vs automatic.**
   - Positions the customer chose are pinned (📌, solid).
   - Every other product flows after them by the section's fallback rule (lighter
     style, labelled "automatico").
   - Dropping a card pins it. "Togli posizione fissa" lets it flow again. That is the
     whole model.
3. **Every drag has a non-drag twin**: a position number, "In cima", "In fondo ai fissati".
4. **Multi-select**, then "Metti in cima in quest'ordine".
5. **Presets are a starting point, not a mode.**
   - "Riordina per più venduti / novità / prezzo / disponibilità / più taglie / in saldo"
     fills the pins down to the fold line. The customer then adjusts.
   - The vocabulary is borrowed from the Hive Commerce sorter.
6. **Ghosts.** A pinned product the site hides (sold out, excluded from catalog) stays
   at its position, greyed out, with the reason. "Why isn't it on the site?" then
   answers itself.
7. **Before/after preview** of the first N products before publishing, with moved items
   highlighted.
8. **History with one-click revert**, per section.
9. **Keyboard and touch**: long-press to drag, autoscroll, arrow keys.
10. **Health hints**: no photo, one size left, a price locked below cost, a product in
    no section.

---

## 4. Ordering: options and recommendation

| | A. Global `menu_order` | B. Per-section pins (term meta) | C. Hub-owned rails |
|---|---|---|---|
| Plugin change | none | small: pins, rail query, archive hook, endpoints | large: new block; the homepage leaves Gutenberg |
| Independent order per section | no | yes | yes |
| Membership lives in | Woo terms | Woo terms (+ exclusions) | Hub lists |
| Category pages match the rail | yes, natively | yes, via the archive hook | no |
| Writes per reorder | up to N products (`products/batch`) | 1 term-meta write | 1 option write |
| Failure mode | a reorder here silently reshuffles every section sharing products | a stale pin (product left the term) is ignored | the Hub becomes the CMS |

**Recommendation: B.**

A is the right choice only if no plugin change is acceptable, and its conflict is
structural: one number per product. Under A, the editor would use "slot reuse": it
reassigns the section's own `menu_order` values in the new order, so non-members don't
move. It would also warn about the other sections affected.

**Effective order.** This is the single definition. It is implemented in PHP for the
site and in TypeScript for the Hub preview, with shared test fixtures.

```
visible(term) = publish ∧ in term (incl. descendants) ∧ not exclude-from-catalog
              ∧ (hide_out_of_stock ⇒ instock) ∧ id ∉ excluded(term)
order(term)   = [pinned(term) ∩ visible, in pin order] ++ [visible \ pinned, by fallback(term)]
rail          = first `limit` of order(term)

fallback ∈ { store       : menu_order ↑, title ↑   (today's behaviour, the default)
           | newest      : date ↓
           | bestsellers : total_sales ↓
           | price_asc | price_desc }
```

Two details:

- **Title ties** sort with the database collation, usually `utf8mb4_unicode_ci`. The
  TypeScript side approximates it with `localeCompare("it", { sensitivity: "base" })`.
  The plugin's `rail-preview` endpoint is the source of truth: if the Hub's order
  differs, the Hub shows a banner instead of silently being wrong.
- **Multi-term rails** (`category="a,b"`) ignore pins in v1.

---

## 5. Membership

- **Curated categories** (Tendenza, Saldi, Offerte, Nuovi arrivi): adding or removing a
  product changes its Woo categories.
  - Woo replaces the whole `categories` array on every update. So each write first
    re-reads the product live, the same way Publish re-reads SKUs live.
  - It then sends `existing ∪ {term}` to add, or `existing \ {term}` to remove, up to
    100 products per `POST products/batch`.
  - If a removal would leave a product with no category, WordPress files it under the
    default category. The Hub warns first.
- **Brand sections**: the brand is a fact, so "Rimuovi" becomes "Nascondi da questa
  sezione". That is an exclusion stored in term meta, next to the pins.
- **Picker** ("+ Aggiungi prodotti"): searches the mirror by name, SKU, brand or
  category. New products go on top as pinned by default, or at the bottom as automatic.

---

## 6. Margin × taxonomy: engine design

### 6.1 Scope

```ts
interface RuleScope {
  // …existing axes
  /** Woo product_cat slug — matches products in that category or any child. */
  storeCategory?: string;
  /** Woo product_brand slug — matches that brand or any sub-brand. */
  storeBrand?: string;
}

type ProductScopeAxes = Pick<SourceProduct, /* …existing */> & {
  /** Slugs of every product_cat the store product sits in, ancestors included. */
  storeCategories?: string[];
  /** Same for product_brand. */
  storeBrands?: string[];
};
```

Ancestors are expanded on the product side, so the rule side stays one slug. A "Nike
25%" rule then covers Nike Off-White too, unless a more specific rule takes it.

### 6.2 Precedence

Today, precedence is a numeric weight sum (SKU 10 … source 1), and ties go to the later
rule. Weight sums interact badly with a new axis: a `{brand, secondaryCategory}` rule
(6) would outrank a section rule weighted 5.

The proposal is to compare rules lexicographically instead:

```
key(rule) = [ tier, weight, listIndex ]
  tier   = 3 SKU-scoped · 2 store-term-scoped · 1 everything else
  weight = today's SCOPE_WEIGHT sum
  ties   → the later rule wins (as today)
```

The full precedence becomes **lock > sale rule > SKU rule > section rule >
brand/family/source rule**.

- **Between section rules**, `listIndex` is the customer's priority list (§3.2 D). When a
  rule is created for a sub-brand, it's inserted above its parent brand's rule by default.
- **Margin handling doesn't change.** The most specific rule still takes over the whole
  margin, and the safety nets still merge field by field: minimum € margin, outlier
  guard, rounding, anti-churn. A 5% section still never sells below ask + €20.
- **Callers of `scopeSpecificity`** switch to the same comparator:
  `winningMarkupRuleId`, the drawer's applied rule, and `resolveCategoryPath`.
- **Effect on today's rules.** Nothing changes unless a non-SKU rule's weights add up to
  10 or more. For example, family + sub-family + name = 11, which beats a SKU rule
  today. SKU rules now reliably beat those, which is the documented intent.

### 6.3 Where products get their store axes

| Path | Source of the store axes |
|---|---|
| Sync planning (`previewStoreChunk` → `buildPlan`) | the snapshot product's `categories` / `brands` (kept by the pull, §7.4), turned into slugs plus ancestors via `store_terms` |
| Drawer / product panel | `store_product_terms`, looked up by SKU |
| Margins coverage (`listProductScopeAxes`) | SQL join producing aggregated slug arrays |
| Publish (new products) | identity resolved at create time (`categoryIds`, `brandId`) |
| Catalog products not on the store | none, so section rules correctly don't apply |

Store products and catalog SKUs are linked through `skuKey`. When duplicate store
products share one SKU, the Hub uses the union of their terms.

### 6.4 GoldenSneakers

A section rule would take over the passthrough rule's margin and apply it on top of
`presented_price`, which already includes the upstream markup. The margin would count
twice.

- **v1 proposal:** section rules skip the `goldensneakers` source. That's a guard in the
  resolver, plus a visible "prezzo dal fornitore" badge.
- **Alternative:** price GoldenSneakers products from `offer_price` (cost) with the
  Hub's margins and VAT, and set the feed URL's markup to 0. That's a pricing-model
  change of its own (Q18).

### 6.5 Getting margins onto the site

1. The customer changes a section margin and presses **Anteprima**. The Hub shows the
   proposed prices for the section's SKUs under the draft rules: how many go up, go down
   or stay the same, the average change, and the full list.
2. **Applica** saves the rule and runs `startStoreSync(market, sectionSkus)` until done,
   then `applySync({ priceScope: "all", dryRun: false, sanitize: false, backfillGtins: false })`.

It writes prices only, with no size cleanup triggered from the customer's side. It is
bounded by the section's size and audited in `apply_audit`.

The daily scheduler refreshes asks but doesn't push prices, and that stays the same.
Whether it should push prices (only prices, no cleanup) is Q22.

### 6.6 Sale sections

For Saldi to show struck-through prices, the regular price would be the price without
the section rule, and the sale price the price with it. Today the plan writes only
`regular_price` and preserves manual `sale_price` (the sale rule). This is doable, but
it means a second price column through plan and apply (Q19).

---

## 7. Technical spec

### 7.1 Architecture

```
┌─────────────────── Store Hub (Next.js) ───────────────────┐         ┌────────────── WordPress ──────────────┐
│ /vetrina (shop role)        /… existing tabs (admin)       │         │ WooCommerce REST  wc/v3               │
│      │                                                     │  Woo    │   products, products/batch,            │
│      ▼ server actions (role-guarded)                       │  keys   │   products/categories, products/brands │
│ merch mirror: store_terms, store_products,                 │ ──────▶ │                                        │
│   store_product_terms, vetrina_blocks                      │         │ golden-hive-blocks  wc-gh/v1  (new)    │
│ pricing engine (+ store-term scope)                        │ ──────▶ │   capabilities, homepage,              │
│ sync on SKU subsets (existing)                             │         │   rail-preview, rail-state             │
└────────────────────────────────────────────────────────────┘         │ rail query + archives honour pins      │
                                                                       └────────────────────────────────────────┘
```

### 7.2 golden-hive-blocks extension

The extension lives in `includes/hub-rails.php`, about 150–250 lines.

**Auth.**

- The namespace is `wc-gh/v1`. WooCommerce's key authentication covers `wc/` **and**
  `wc-` routes; the source says "`wc-` lets third party plugins use our authentication
  methods" (`is_wc_namespace()`, verified in trunk).
- So the Hub's existing consumer key and secret authenticate these routes, with no
  Application Password needed.
- The permission callback checks `current_user_can('manage_woocommerce')`. Woo enforces
  the key's read/write level per HTTP method.
- Fallback: the Application Password pattern that `gh/v1/roundtrip/*` already uses.

**Endpoints.**

| Method | Route | Returns / does |
|---|---|---|
| GET | `/capabilities` | plugin version and features. Without them, the Hub drops to read-only |
| GET | `/homepage` | reads the front page (`page_on_front`) with `parse_blocks`, recursively. Returns an ordered list: rails (block path, eyebrow, title, taxonomy, slugs, term ids, limit, type, columns, background, button), non-rail blocks as placeholders, and the page's `modified` time |
| GET | `/rail-preview?taxonomy&term&limit` | the ids the rail renders **now**. This is the source of truth for the Hub's preview |
| GET | `/rail-state?taxonomy&term` | `{ pinned, excluded, fallback, revision }` for one term, or for every term that has state |
| PUT | `/rail-state` | same body plus `expected_revision`, which returns 409 on a mismatch. Bumps the revision and purges the page cache |

**Storage.** Term meta on the `product_cat` / `product_brand` term:

- `_gh_rail_pinned` (int[], at most 100)
- `_gh_rail_excluded` (int[])
- `_gh_rail_fallback`
- `_gh_rail_revision`

**Rail query.** In `ghb_get_carousel_products()`, when exactly one term resolves and it
has state:

1. Get the term's visible ids, ordered by the fallback rule (`fields => ids`,
   `no_found_rows`), minus the excluded ones.
2. Move the pinned ids to the front, keeping everything else in order.
3. Cut the list to `limit`.
4. Render with `post__in` + `orderby => post__in`.

That's two queries, and any WordPress `orderby` works as a fallback, meta sorts
included. The id list is cached in a transient keyed by term, revision and stock
option. The cache is invalidated on `save_post_product`, on a stock status change, and
on a state PUT.

**Category and brand pages.** On the main query of that term's archive, when the
visitor hasn't chosen another sort (`orderby` = `menu_order`):

- prepend `FIELD(ID, pins…) = 0, FIELD(ID, pins…)` via `posts_clauses` (pagination
  keeps working);
- exclude the `excluded` ids;
- provide a filter to opt out.

**Cache purge** after a state PUT: fire `do_action('gh_rail_state_published', …)`, plus
the known purges when present (LiteSpeed, WP Rocket, W3TC…). Cloudflare depends on
the setup (Q25).

**Later (phase 5):** `PUT /homepage/rail`, to edit a rail's attrs (title, eyebrow,
limit, term) and to reorder or add rails.

- It runs `parse_blocks` → change the block → `serialize_blocks` → `wp_update_post`.
  That creates a WP revision, which doubles as undo.
- It is guarded by `expected_modified`.

### 7.3 Hub data model (Drizzle)

```ts
// Woo terms, both taxonomies. Refreshed by the merch pull.
store_terms {
  taxonomy: "product_cat" | "product_brand"; termId: int; parentId: int /* 0 = root */;
  slug; name; count: int; menuOrder: int | null; image: text; syncedAt;
  PK (taxonomy, termId) · idx (taxonomy, slug)
}

// One row per published store product (simple AND variable): the merchandising mirror.
store_products {
  id: int PK /* Woo id */; sku; name; type; status; menuOrder: int; featured: bool;
  catalogVisibility; stockStatus; price: numeric | null; regularPrice; salePrice; onSale: bool;
  image; permalink; totalSales: int; dateCreated; dateModified; syncedAt;
  idx (sku)
}

store_product_terms { productId; taxonomy; termId;  PK (all) · idx (taxonomy, termId) }

// Homepage structure, as read from /homepage.
vetrina_blocks {
  position: int PK; path: text; kind: "rail" | "static"; blockName;
  title; eyebrow; taxonomy: text | null; termSlugs: text[]; termIds: int[]; limit: int | null;
  attrs: jsonb; pageModified: timestamp; syncedAt;
}

// Per-term rail state: the published copy (mirror of the term meta) + the customer's draft.
vetrina_section_state {
  taxonomy; termId;  PK (taxonomy, termId);
  published: jsonb /* { pinned, excluded, fallback, revision } */;
  draft: jsonb | null /* { pinned, excluded, fallback, addIds, removeIds } */;
  draftUpdatedAt;
}

// Every publish (order, membership, prices, margins), with what it replaced.
vetrina_publish_log {
  id: uuid; kind: "order" | "membership" | "prices" | "margin"; taxonomy; termId: int | null;
  before: jsonb; after: jsonb; result: jsonb; role; at;
}
```

Rules stay in `config.pricingRules`, so one engine prices everything. Section rules
carry `origin: "vetrina"`. The developer's Margins tab shows them flagged, and the
customer only ever sees and edits those.

### 7.4 The merch pull

- **Full pull** (nightly, plus a button):
  - `GET products?status=publish&per_page=100&_fields=id,sku,name,type,status,menu_order,featured,catalog_visibility,stock_status,price,regular_price,sale_price,on_sale,images,categories,brands,total_sales,date_created,date_modified,permalink`
  - It fetches no variations, so it's one request per 100 products: a 3,000-product
    shop takes about 30 requests.
  - Plus `products/categories` and `products/brands` (`per_page=100`, paged).
- **Incremental pull** (every ~10 minutes, from the scheduler): the same query with
  `status=any&modified_after=<last>`, so it also catches unpublished products.
- **Write-through**: every Hub write patches the mirror, the same way apply patches the
  snapshot.
- **The existing variable-only snapshot pull** keeps its job (plan and apply). It also
  keeps `categories` / `brands` / `menu_order` per product, so the plan engine sees
  store axes without a second lookup.
- It reuses `pageVerdict` (the guard against installs that ignore `?page`) and the HTTP
  retry policy.

### 7.5 Server actions (new)

| Action | Roles | Notes |
|---|---|---|
| `getVetrina()` | shop, admin | blocks in homepage order, plus the first N products per rail from the mirror and state |
| `getSection(taxonomy, termId)` | shop, admin | the full ordered list, with flags: pinned, visible or hidden (and why), locked, margin, other sections |
| `saveSectionDraft(…)` / `discardSectionDraft(…)` | shop, admin | local only |
| `publishSection(taxonomy, termId)` | shop, admin | membership writes (live re-read, batched) → `PUT rail-state` with the expected revision → mirror patch → log |
| `revertPublish(logId)` | shop, admin | publishes `before` |
| `searchStoreProducts(q, filters)` | shop, admin | the picker |
| `previewSectionMargin(draft)` / `applySectionMargin(…)` | shop, admin | see §6.5 |
| `saveProductPrices(sku, prices)` | shop, admin | locks plus a prices-only sync of one SKU. Simple products use `PUT products/{id}` |
| `refreshMerchMirror({ full })` | admin (+ scheduler) | see §7.4 |
| `verifyRails()` | admin | compares the Hub's order with `rail-preview`, rail by rail |

Every existing action that writes to Woo or to config gets `requireRole("admin")` (§7.7).

### 7.6 UI

- **Route groups** (URLs don't change):
  - the root layout keeps `<html>`, the theme and i18n;
  - today's header and `MainNav` move to `src/app/(admin)/layout.tsx`, together with
    every existing route;
  - the new `src/app/(vetrina)/vetrina/…` gets a slim header: logo, "Vetrina", "Vedi il
    sito", logout;
  - the admin nav gains a "Vetrina" tab.
- **Routes**:
  - `/vetrina`, `/vetrina/[taxonomy]/[slug]`, `/vetrina/categorie`, `/vetrina/margini`;
  - the product panel opens with `?prodotto=<id>`. It's deep-linkable and the back
    button closes it, the same pattern as the drawer.
- **Drag and drop**: **`@dnd-kit/core` + `@dnd-kit/sortable`**. They're MIT-licensed,
  handle pointer, touch and keyboard, sort grids, and announce moves to screen readers.
  They aren't TanStack packages, so the CI guard is unaffected.
- **Rendering**: server components for reads, client components for the editor. SWR is
  already a dependency, for polling a running apply.
- **Copy**: written in `it.ts` first, then mirrored in `en.ts` (the existing convention).

### 7.7 Roles

- `APP_PASSWORD` stays the admin password (everything, as today). A new `SHOP_PASSWORD`
  gives the shop role.
- **Session tokens**:
  - Admin: the token stays exactly as today, so nobody gets logged out.
  - Shop: `HMAC(SHOP_PASSWORD, "store-hub-session-v1:shop")`.
  - The proxy matches the cookie against both tokens to get the role.
- **The shop role** can reach `/vetrina/**` and `/login`, plus `/orders` if Q3 says so.
  Anything else redirects to `/vetrina`.
- **Server actions are POST endpoints reachable from any page**, so the proxy alone
  can't protect them. Next's own guidance is to treat every action as a public
  endpoint.
  - So `requireRole()` runs inside each action, reading the cookie through `cookies()`.
  - Actions the shop role may call are listed explicitly, and everything else is denied
    by default.

### 7.8 Publishing safety

- **One explicit button per write**, with a count and a summary. Order changes also get
  a before/after preview.
- **Optimistic concurrency**:
  - `expected_revision` on rail state;
  - a live re-read before membership writes;
  - `assertSnapshotIsThisStore()` before any price write.
- **Logging**: everything goes to `vetrina_publish_log`, and prices also to
  `apply_audit`. Reverting means publishing `before`.
- **Customer-triggered syncs are prices-only**: `sanitize: false`, no GTIN backfill, no
  product creation.
- **If the plugin is missing or too old**, `/capabilities` says so, and the Vetrina
  becomes read-only with a banner.

### 7.9 Tests

- **`core/__tests__`**:
  - `storeCategory` / `storeBrand` matching, with ancestors;
  - tier precedence: SKU > section > family/brand;
  - priority by list order;
  - the GoldenSneakers guard;
  - safety nets still merging under a section margin.
- **Ordering**: `src/lib/vetrina/order.ts` (`effectiveRailOrder`) is pure and
  table-tested. The same JSON cases drive a PHP test of the plugin's ordering helper.
- **Other units**:
  - homepage payload parsing;
  - the role guard, in both the proxy and the actions;
  - membership read-modify-write, which must never drop a product's existing categories.
- **Live check**: `verifyRails()` is the contract check after every deploy.

---

## 8. Phasing

| Phase | Scope | Done when |
|---|---|---|
| 0 | This doc → answers → "agreed" | every blocking question is answered |
| 1 · See | Roles; route groups; merch mirror + scheduler; plugin read endpoints (`capabilities`, `homepage`, `rail-preview`); read-only Vetrina, section view, category and brand browser | for every homepage rail, the Hub shows the same products as the site, in the same order (`verifyRails()` green) |
| 2 · Price | Store-term scope, precedence and tests; Margini per sezione (priority, conflicts, preview, apply); product panel with locks and "Salva e pubblica" | changing Saldi to 10% first shows the price changes, then updates exactly Saldi's products; a lock goes live in one action and survives the next full Sync |
| 3 · Order | Plugin: pins, exclusions and fallback in rails and archives, `rail-state`, cache purge. Editor: grid and list, drag, non-drag twins, presets, ghosts, before/after, history | reorder → publish → the homepage and category page match; revert restores the previous order |
| 4 · Fill | Add and remove for curated categories, the picker, hiding in brand sections | adding or removing never loses a product's other categories |
| 5 · Shape (optional) | Edit rail titles, limits and terms; reorder or add rails; maybe hero, slider and marquee | a rail edited in the Hub shows on the site, with a WP revision behind it |

Phases 2 and 3 can swap if order matters more than margins. Phase 2 needs no plugin
deploy.

---

## 9. Decisions needed

Answer by number. **B*n*** means the question blocks phase *n*.

### People and product

1. **B1** — The reference image didn't come through. Can you re-attach it or describe it?
2. **B1** — What will the customer use: phone, tablet or desktop?
   *Recommended: list-first on phone, grid on desktop.*
3. **B1** — Should the customer get a separate login that only sees the Vetrina (and
   Ordini?), while you keep everything?
   *Recommended: yes, with `SHOP_PASSWORD`.*
4. Is "Vetrina" the right name?
5. You listed "products themselves". Beyond membership, order and price, which fields
   must the customer edit: name, photos, description, per-size stock,
   publish/unpublish?
   *Recommended for v1: none, plus a "Modifica su WordPress" link.*
6. **B1** — How are changes saved: an explicit yellow button with history and undo, or
   autosave?
   *Recommended: the explicit button.*

### Ordering

7. **B3** — Is it OK to extend `golden-hive-blocks` for per-section order (pins in term
   meta)? The alternative is global `menu_order` only, accepting cross-section conflicts.
   *Recommended: extend the plugin.*
8. What order should products follow after the pinned ones: today's (`menu_order` then
   name), newest, bestsellers or price? And should it be chosen per section?
   *Recommended: per section, defaulting to today's order so nothing moves on day one.*
9. Should category and brand pages (where the "Esplora" buttons land) show the same
   order as the rail?
   *Recommended: yes.*
10. How is NUOVI ARRIVI filled today — does someone tag `new-nuove-release` by hand?
    Should it stay manual, or become automatic (created in the last N days)?

### Membership

11. **B4** — Should the customer add and remove products in the curated sections? That
    means assigning Woo categories.
12. Should brand sections allow "Nascondi da questa sezione"?

### Homepage structure

13. v1 mirrors the homepage read-only. Should the Hub later edit sections — titles,
    limits, section order, new sections, hero, slider, marquee? Which of these, if any?
14. **B1** — Is it OK to authenticate the new plugin endpoints with the existing Woo keys
    (a `wc-`-prefixed namespace), or do you prefer an Application Password?

### Prices and margins

15. **B2** — What does a section margin look like: one % per section, or also fixed € and
    price bands?
    *Recommended: one %.*
16. **B2** — A product in two sections with different margins: explicit priority, lowest
    wins, or highest wins?
    *Recommended: explicit priority.*
17. **B2** — Do you agree that section margins beat your brand/family rules, lose to
    per-SKU rules and locks, and that your safety nets (min €20 margin, outlier guard,
    rounding) keep applying?
18. **B2** — GoldenSneakers products: exclude them from section margins in v1, or re-base
    them on `offer_price` plus the Hub's margin?
    *Recommended: exclude in v1.*
19. Saldi: struck-through price (regular + sale), or just a lower price?
20. **B2** — When the customer edits or locks a price in the Vetrina, does it go live
    immediately for that product, or wait for your Sync?
    *Recommended: immediately.*
21. **B2** — When the customer changes a section margin: preview, then apply to that
    section right away, or wait for Sync?
    *Recommended: preview, then apply right away.*
22. Who runs the full Sync, and how often, now that the customer changes margins? Should
    the scheduler push prices daily (prices only, no cleanup)?

### Store facts

23. **B1** — How many published products are there (and how many are simple vs
    variable), how many categories and brands? Roughly how many products sit in two or
    more homepage sections?
24. What share of products comes from each price source: StockX, GoldenSneakers,
    store-only?
25. **B3** — Is there a page cache or CDN in front of the homepage (LiteSpeed, WP Rocket,
    Cloudflare…)?
26. Is "Nascondi prodotti esauriti" on in WooCommerce?
27. Does anyone reorder or recategorize products in WP admin (for example with the Hive
    Commerce sorter)? This decides the refresh cadence and how conflicts are handled.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Hub features depend on the plugin's version | `/capabilities`; read-only fallback; required plugin version noted per phase |
| The page cache serves the old homepage after a publish | purge hooks (§7.2); "Vedi il sito" with a cache-busting parameter; `verifyRails()` |
| Double margin on GoldenSneakers products | resolver guard + badge (§6.4) |
| A margin change moves many prices | preview first; bounded to the section; audited; revertable (re-save the previous margin and apply) |
| Mirror goes stale after edits in WP admin | incremental pull; live re-read before membership writes; revision on rail state |
| The customer reaches destructive tools | role split, per-action guards, deny by default |
| Scope creeps into a page builder | phase 5 is optional and separate |
