# Vetrina — the customer's homepage editor (design + spec, v1)

Status: **phases 1–2 implemented, phase 3 in part** (see
[Implementation status](#implementation-status)). Not merged.
v1 builds on the page-editor idea: the WordPress homepage is the thing being edited,
and the Hub only adds prices.

- [§1](#1-the-approach-page-editor-or-new-software) explains why.
- [§12](#12-open-questions) lists what is still open.

v0 (the "new software" design) is in git history. Its reasoning is summarized in
[Appendix A](#appendix-a-v0-hub-owned-sections--why-not).

Repositories involved:

- **this one** (Store Hub): the editor UI, prices, margins.
- **`golden-hive-blocks`**: renders the homepage. Needs three rail attributes and a small
  REST endpoint ([§6](#6-storefront-side-golden-hive-blocks)).

## Decisions so far

| Q | Topic | Decision |
|---|---|---|
| 2 | Device | **Phone first.** Changed in v1: editing uses a list on every device. The grid is a read-only preview, which keeps one code path (§4). |
| 3 | Separate login | **No.** The customer uses the existing Hub login. Which tabs they see comes from code config (§5). |
| 4 | Name | Vetrina |
| 5 | Product fields | None in v1. The editor has a "Modifica su WordPress" link. |
| 6 | Save model | Explicit publish button, with history (WordPress revisions) |
| 7 | Plugin change | Yes, in `golden-hive-blocks` |
| 8 | Order after the pinned products | Chosen per rail. Default: today's store order. |
| 9 | Category pages follow the rail | Yes. A category page uses the pins of the homepage rail that shows that category (§6.4). |
| 13 | Homepage structure | Read-only in the UI. What is editable is decided by code config (§5). |
| 14 | Plugin auth | `wc-gh/v1` namespace, authenticated with the existing Woo keys |
| 15–18 | Margins | One % per section. Explicit priority between sections. Precedence: lock > SKU rule > section > brand/family rule, with the safety nets still applied. GoldenSneakers excluded in v1. |
| 20–21 | Going live | A price edit goes live immediately. A margin change is previewed, then applied to the section right away. |
| — | Mobile | "Specifically clean UX for mobile": dedicated libraries (§4.4) |

## Implementation status

Branch `claude/custom-product-catalog-ui-sqzewp`, in both repositories.

| Phase | State |
|---|---|
| 1 · See | Done |
| 2 · Order | Done: pin / exclude / fallback, publish, history and restore, category pages follow their rail |
| 3 · Price | Product sheet with locks and one-product publish: done. Margin × taxonomy (store-term scope, margin sheet): not started |
| 4 · Fill | Not started |
| 5 · Shape | In part: a section's eyebrow, title, button, background and size; the titles of the category slider, brand marquee and FAQ (plus its subtitle). Slides, cards and logos stay in WordPress |

### How to test

1. **Demo, without touching the shop**: run the Hub with `VETRINA_SOURCE=fixture` and
   open `/vetrina`. It is an in-memory copy of the homepage; it resets on restart.
2. **Against a staging copy of the shop**:
   - install golden-hive-blocks **5.10.0** from the branch above (5.9.0 is enough
     for ordering; texts and sizes need 5.10.0);
   - the Hub's WooCommerce key needs **Read/Write**, and its user needs
     `manage_woocommerce` (Shop manager or Administrator);
   - open `/vetrina`, tap a section, reorder, **Pubblica**. The homepage and that
     category's page follow; each publish is a WordPress revision.
3. **Prices**: in a section, `⋯` → **Prezzi e taglie**. A price typed on a size locks it;
   **Salva e pubblica** writes this one product's prices to the site.
4. **Texts and look**: in a section, **Titolo, testi e aspetto** edits the eyebrow,
   title, button, background and how many products show; the change joins the draft
   and goes live with **Pubblica**. On the home screen, the FAQ, category slider and
   brand marquee rows open their titles, saved straight to the site.

Notes:

- After login the Hub now opens `/vetrina` (`ui.landing` in `src/config/hub.config.ts`).
  Every old tab is still in the nav.
- Each publish purges the page cache (LiteSpeed, WP Rocket, W3TC, WP Super Cache,
  SiteGround). Behind another cache or a CDN, the change shows when that cache expires.
- Which fields are editable is config: `edit.fields` and `edit.limit` per block in
  `hub.config.ts`, within the plugin's allowlist (`ghb_hub_field_specs`, mirrored in
  `src/lib/vetrina/fields.ts`). The plugin sanitizes every value: text loses its tags,
  links must be http(s) or start with `/`.
- On a desktop the Vetrina is a phone-width column in the middle of the screen.

---

## 0. TL;DR

- **The homepage is the source of truth.** The Vetrina is a mobile editor for the
  WordPress homepage:
  - it reads the page's blocks;
  - it lets the customer reorder and hide products in each rail;
  - it writes back **one block's attributes** per publish;
  - every publish is a WordPress revision, so undo comes for free.
- **Prices stay in the Hub.** That's not a preference: the Hub's sync writes store prices,
  so a price set anywhere else gets overwritten. Locks and margin × taxonomy live in the
  Hub's engine and appear inside the same editor.
- **It's one editor with two sources of truth**, each kept where it already lives:
  WordPress for what shows and in what order, the Hub for the prices. It is not two
  pieces of software.
- **The editor lives in the Hub, not in WP admin.** Prices are one call away there, the
  mobile UI isn't constrained, and the customer uses one app.
- **Mobile stack:**
  - **Konsta UI v5**: iOS / Material look, Tailwind 4, React 19.
  - **Motion `Reorder`**: drag from a grip handle.
  - **react-modal-sheet**: swipeable bottom sheets.
  - **Sonner**: undo toasts.
  - **An installable home-screen app**, using a manifest and no service worker.
- **Much less to build than v0.** No new database tables, no mirror of WordPress state.
  The plugin gets three rail attributes (`pin`, `exclude`, `fallback`) and one small
  read/write endpoint.

---

## 1. The approach: page editor or new software?

### 1.1 The two approaches

|  | **A. New software** (v0) | **B. Page editor** (your pick) |
|---|---|---|
| What the Hub edits | its own model: copies of Woo terms, products, memberships, per-category pins | the homepage page itself: the attributes of its blocks |
| Source of truth for "what shows, in what order" | Hub state, pushed to WordPress | the page |
| History / undo | custom publish log | WordPress revisions |
| Staying in sync | mirror tables, scheduled pulls, staleness checks | the editor reads the live page when opened |
| New Hub tables | 6 | 0 |
| Grows to hero, slider, marquee | a new project each | a config line each: they are block attributes too |

### 1.2 Verdict

**B, hosted in the Hub, with prices handled by the Hub engine.** That's the "both"
worth doing: one editor, where each piece of data stays with its natural owner.

- The **page** owns sections, products per rail, order, and hidden products.
- The **Hub** owns prices, locks, and margin × taxonomy.

### 1.3 Why B wins

1. **One truth, no drift.** What the customer edits is exactly what the page
   renders. A copied the WordPress state into the Hub and then had to keep it fresh.
2. **History for free.** Every publish creates a revision. "Ripristina" means publishing
   the block's attributes from an earlier revision.
3. **A fraction of the code.** There are no mirror tables, pull jobs or term state.
4. **It grows by config.** Hero slides, the category slider and the brand marquee are
   block attributes like the rails. "Editable later" means flipping a config flag, with
   no new mechanism (§5).
5. **It's transparent for you.** The pins show up in Gutenberg, inside the shortcode
   (`pin="1201,877,1543"`). You can read them and fix them by hand.

### 1.4 What B costs, and the answer to each

| Cost | Answer |
|---|---|
| The editor writes homepage content, so a bug could break the page | The plugin changes only allowlisted attributes of one block. It matches that block exactly once or refuses. It validates values against the block's own `block.json`. It rejects stale writes and keeps a revision (§6.3). |
| Order belongs to the homepage rail, not the category, so category pages don't follow by themselves (Q9) | A category page uses the pins of the homepage rail that shows it. About 50 lines in the plugin (§6.4). |
| Margins need the Hub to know each product's Woo categories and brands | The existing store pull keeps `categories` / `brands` and the term tree. No new tables (§8.3). |

### 1.5 Why prices can't live in a WordPress page editor

- The Hub computes shelf prices from StockX asks and margins.
- Its sync writes those prices to Woo, and overwrites any price that isn't locked **in
  the Hub**.
- So a price edited in WordPress lasts only until the next sync.
- Margin × taxonomy is a rule inside that same engine.

Anything about price has to go through the Hub. That is the hard technical reason the
Vetrina can't be a pure WordPress editor.

### 1.6 Why the editor lives in the Hub, not in WP admin

- **Prices, locks and margins** are server actions away. From WP admin, they would need a
  new Hub API and a token stored in WordPress.
- **Full freedom for mobile UX.** WP admin on a phone is poor. A custom admin page would
  still carry its chrome and build tooling.
- **One app for the customer**, which matches "everything configurable from this hub
  platform".
- **The Hub already holds the Woo keys** that authenticate the plugin endpoint (Q14).
  Nothing new to configure.

WP admin's one advantage would be WordPress's own roles. You don't want a separate
customer login anyway (Q3), so that advantage is moot.

### 1.7 Login (Q3)

v0 proposed a second password on the same login page, about 40 lines. It's dropped.

- The customer logs into the Hub as today.
- `/vetrina` becomes the landing page.
- The tabs shown in the nav come from code config. That config is how the old UI gets
  progressively leaner.
- Residual risk: anyone with the password can still open `/sync` by typing the URL.
  Destructive runs there stay dry-run-first.

---

## 2. What exists today (audit summary)

### 2.1 The homepage

| # | Block | Shows | Driven by | Limit |
|---|---|---|---|---|
| 1 | hero-carousel | 5 slides | static attrs | — |
| 2 | trust-badges | 5 badges | static | — |
| 3 | Hustle embed | newsletter | Hustle | — |
| 4 | **rail** | PRODOTTI IN TENDENZA | `product_cat` `featured-sneakers-originali-streetwear` | 18 |
| 5 | **rail** | SALDI | `product_cat` `saldi-sneakers-outlet` | 18 |
| 6 | **rail** | SNEAKERS | `product_cat` `saldi-sneakers-in-offerta` | 18 |
| 7 | category-slider | 7 cards | static attrs | — |
| 8 | **rail** | NUOVI ARRIVI | `product_cat` `new-nuove-release` | 18 |
| 9 | **rail** | Nike Off-White | `product_brand` `nike-off-white` | 15 |
| 10 | **rail** | Nike Air Force 1 | `product_brand` `nike-air-force-1` | 15 |
| 11 | brand-marquee | 7 logos | static | — |
| 12 | **rail** | ADIDAS | `product_brand` `adidas` (+ sub-brands) | 15 |
| 13 | **rail** | NEW BALANCE | `product_brand` `new-balance` | 15 |
| 14 | **rail** | ASICS | `product_brand` `asics` | 15 |
| 15+ | faq, social, social-proof, whatsapp | static | — | — |

That's 9 rails and 147 product slots. Every rail is a
`golden-hive/shortcode-wrapper` block whose `shortcode` attribute holds
`[gh_product_rail category|brand=… limit=… columns=…]`.

### 2.2 How a rail chooses and orders products

The code path is `ghb_get_carousel_products()` in `golden-hive-blocks`.

- **Membership**: the product is in the term, including child terms. Brand rails check
  `product_brand` / `pwb-brand` / `pa_brand`.
- **Visibility**:
  - `publish` only;
  - not `exclude-from-catalog`;
  - not `outofstock` when WooCommerce's "Hide out of stock items" is on.
- **Order**: **`menu_order ASC, post_title ASC`**, whenever a category or brand is set.
  `menu_order` is one number per product, shared by every rail and every category page.
  That's why a single global order can't serve several rails at once.
- **Count**: the first `limit` products that pass the filters above.

Verified in WooCommerce trunk:

- the REST API reads and writes `menu_order`, accepts `orderby=menu_order`, returns
  `brands`, and supports `modified_after`;
- routes under `wc-*` namespaces accept WooCommerce API keys: `is_wc_namespace()`,
  "lets third party plugins use our authentication methods".

### 2.3 Store Hub: reused as is

- **The pricing engine**: scoped rules, whole-margin takeover, safety nets.
- **Price locks**: `store_overrides`, keyed `SKU::EU size`.
- **Drawer data**: ask, proposed price, applied rule.
- **Sync on a SKU subset**: `startStoreSync(market, skus)` → `advanceStoreSync` →
  `applySync({ sanitize: false })`.
- **Direct edits** of store-only products.
- **The site guard**.
- **The Woo client**.
- **The Italian dictionaries**.

### 2.4 Gaps that still matter in v1

1. The store pull drops `categories` / `brands` and has no term tree. The margin engine
   needs both (§8.3).
2. Rules can't target a Woo term (§8).
3. A lock reaches the store only through a Sync run. v1 adds a prices-only publish per
   SKU (§8.5).
4. GoldenSneakers prices already include the supplier's markup, so they're excluded from
   section margins in v1.

### 2.5 Spotted along the way

- "Esplora le tendenze" never renders: `buttonText` is set but `buttonUrl` is missing.
- Copy: the eyebrow says "Saldi primaverili" (spring sales) in autumn, and "Offerte
  speciale" should be "Offerte speciali".
- The social-proof popups are hardcoded.
  - If they aren't real purchases, that's a misleading-practice risk under EU and
    Italian consumer law.
  - The Hub already mirrors real orders and could feed real ones.
- The brand marquee hotlinks two logos from upload.wikimedia.org.

---

## 3. Architecture

```
            Customer's phone (installed as an app)
                         │
┌────────────────────────▼──────────────── Store Hub (Next.js) ───────────────────────────┐
│ (vetrina) route group: Konsta shell, list editor, sheets                                 │
│   server actions ──┬── page:  wc-gh/v1/homepage (read), /rail (read), /block (write)     │
│                    ├── prices: overrides (locks) + prices-only sync of a SKU subset      │
│                    └── margins: config.pricingRules (store-term scope) + section apply    │
│ hub.config.ts ── what is shown, what is editable, which tabs exist                       │
└────────────────────────┬─────────────────────────────────────────────────────────────────┘
                         │ Woo consumer key/secret (existing)
┌────────────────────────▼──────────────── WordPress ─────────────────────────────────────┐
│ WooCommerce REST wc/v3 (products, categories, brands, variations/batch)                 │
│ golden-hive-blocks                                                                      │
│   [gh_product_rail … pin="…" exclude="…" fallback="…"]   ← the order lives in the page  │
│   wc-gh/v1: capabilities · homepage · rail · homepage/block (PUT) · homepage/history    │
│   category pages follow their homepage rail's pins                                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. The editor

### 4.1 Principles

1. **Mirror the site.** The first screen is the homepage as it renders now, block by
   block, with each rail's products computed by the plugin's real query.
2. **One editing surface.** A list with a grip on every row, on every device. On desktop
   the list is centred, with the rail's preview beside it.
3. **Nothing reaches the site before "Pubblica"**, and every publish can be restored.
4. **Plain Italian, big targets, no jargon.**
5. **Every gesture has a button twin.** Drag, or open ⋯ and use the actions.

### 4.2 Screens

**Home: "La tua homepage"**

```
┌─────────────────────────────────┐
│  Vetrina                    ⟳   │  ← Konsta Navbar (large title)
├─────────────────────────────────┤
│  Hero · 5 slide           (sito)│
│ ┌─────────────────────────────┐ │
│ │ PRODOTTI IN TENDENZA      › │ │  ← tap: open the rail
│ │ ▢ ▢ ▢ ▢ ▢ ▢ →   18 in vetrina│ │  ← horizontal strip, first products
│ │ Margine 30% · 2 esauriti    │ │
│ └─────────────────────────────┘ │
│ ┌─────────────────────────────┐ │
│ │ SALDI                     › │ │
│ │ ▢ ▢ ▢ ▢ ▢ ▢ →               │ │
│ └─────────────────────────────┘ │
│  Slider categorie · 7     (sito)│
│  …                              │
├─────────────────────────────────┤
│  Vetrina · Margini · Ordini     │  ← Tabbar, tabs from hub.config.ts
└─────────────────────────────────┘
```

**Rail editor**

```
┌─────────────────────────────────┐
│ ‹ Vetrina   TENDENZA        ⋯   │
│ Automatico: [Negozio|Novità|Più venduti] │ ← Segmented = `fallback`
├─────────────────────────────────┤
│ 1 ▢ Jordan 4 Military…  €219 📌 ⋮⋮│ ← grip ⋮⋮ = drag handle only
│ 2 ▢ Dunk Low Panda      €129 📌 ⋮⋮│
│ 3 ▢ Samba OG            €139 🔒 ⋮⋮│   🔒 = a price is locked
│ 4 ▢ NB 9060 …           €179    ⋮⋮│ ← automatic (lighter)
│ …                                │
│ ── in homepage si vedono i primi 18 ──│
│ 19 ▢ …                           │
│ Nascosti: ▢ esaurito  ▢ nascosto │
├─────────────────────────────────┤
│  3 modifiche    [ Pubblica ▶ ]   │ ← sticky, above the home indicator
└─────────────────────────────────┘
```

- **Tapping a row** opens the **product sheet**: photo, "prezzo sul sito", sizes with 🔒
  (editing a price locks it), "Salva e pubblica".
- **The ⋯ row action** opens an **action sheet**: In cima · Sposta in posizione… · Togli
  posizione fissa · Nascondi da questa sezione · Prezzi…
- **Tapping "Margine 30%"** opens the **margin sheet**: one %, a preview of the impact
  (up / down / unchanged), "Applica".

### 4.3 The ordering model, in the customer's words

- **"Fissati" (pinned) come first, in your order. Everything else follows
  automatically**, by the rule chosen in the segmented control.
- **Dragging a row pins it.**
  - Dropping it inside the automatic zone pins everything above it too. Pins are always
    a prefix of the list.
  - "Togli posizione fissa" sends a product back to the automatic zone.
- **A sold-out or hidden pinned product stays in the list, greyed out, with the reason**,
  so "why isn't it on the site?" answers itself.
- **Moves are optimistic**, with an undo toast ("Spostato in cima · Annulla"). Nothing is
  written until "Pubblica".

### 4.4 Mobile stack (checked on npm, 30 Sep 2026)

| Need | Pick | Why | Version · last release · license |
|---|---|---|---|
| App look: navbar, lists, tabbar, toggles, segmented, action sheets, search | **Konsta UI** (`konsta`) | iOS 26 / Material 2025 look out of the box. Built on Tailwind v4 (our stack) and updated to React 19. | 5.5.0 · 28 Sep 2026 · MIT |
| Drag to reorder | **Motion** `Reorder` + `useDragControls` | Spring animations and autoscroll. `dragListener={false}` + a grip with `touch-action: none` keeps page scrolling intact. | `motion` 13.4.6 · 29 Sep 2026 · MIT |
| Swipeable bottom sheets (product, margin, picker) | **react-modal-sheet** | Swipe to close, snap points, virtual-keyboard avoidance built in. Runs on Motion, so no second animation engine. | 5.6.0 · Mar 2026 · MIT |
| Toasts with undo | **Sonner** | Stacked, swipe to dismiss, action button | 2.0.8 · Aug 2026 · MIT |
| "Install on phone" | Next's built-in `app/manifest.ts` + Apple web-app metadata | Full-screen home-screen app. **No service worker**: the Vetrina must always be live, and a service-worker cache is the classic source of "I published but I see the old one". | built in |

Considered and rejected:

- **Vaul**: officially unmaintained, and its bugs propagate into shadcn's Drawer.
- **Silk**: native-like sheets, but commercial use needs a paid license.
- **`@dnd-kit/core` / `sortable`**: no release since Dec 2024. `@dnd-kit/react` is still
  0.x, its touch sensor was reworked, and there are reports of lag on mobile lists.
- **Pragmatic drag and drop and React Aria DnD**: both use native HTML drag on touch,
  which means a ghost-image drag with no live reflow. React Aria's accessibility is
  excellent, but the feel is less app-like.
- **`@use-gesture/react`**: no release since Mar 2024.
- **Serwist**: it now supports Next 16 / Turbopack, but it's only worth adding if offline
  ever becomes a goal.

Spike before building: mount Konsta inside our Tailwind 4 build, scoped to the
`(vetrina)` layout, and check it doesn't collide with the Hub's `@theme inline` tokens.
The existing gold accent becomes Konsta's primary colour.

### 4.5 Mobile details that make or break it

- **Drag starts only from the grip.** The rest of the row scrolls. Tapping the row opens
  it.
- **Keep the fixed bars clear of the phone's edges:** sticky bottom bars use
  `env(safe-area-inset-bottom)`, and layouts use `100dvh`, not `100vh`.
- **Price inputs:**
  - 16 px font minimum, because iOS zooms on focus below that;
  - `inputmode="decimal"` and `enterkeyhint="done"`;
  - comma decimals accepted ("189,99").
- **Thumbnails** use WordPress's `woocommerce_thumbnail` size, lazy-loaded. Never
  full-size images on mobile data.
- **Sheets** get `overscroll-behavior: contain`, so scrolling a sheet never scrolls the
  page behind it.
- **One network write per publish.** Moves are local until then.
- **No hover-only affordances.** Everything reachable by tap.

---

## 5. Config as code

"Everything must be configurable by code configs" is read here as follows:

- The **editor's behaviour** lives in one typed file.
- **Data** (margins, locks) stays data, edited in the UI.
- **What the customer is allowed to see and edit** is code, changed by you.

```ts
// src/config/hub.config.ts — validated with Zod at startup
export default defineHubConfig({
  ui: {
    landing: "/vetrina",
    theme: "ios",                         // "ios" | "material"
    // Tabs in the nav. Leaning the old UI = removing entries here.
    nav: ["/vetrina", "/vetrina/margini", "/orders", "/catalog", "/pricing", "/sync"],
  },
  vetrina: {
    page: "front",                        // or { id: 123 }
    blocks: {
      "golden-hive/shortcode-wrapper": {
        rail: "gh_product_rail",
        show: "rail",
        edit: {
          pins: true, exclude: true, fallback: true,
          title: false, eyebrow: false, limit: false, button: false, // Q13: read-only for now
        },
        maxPins: 60,
        fallbacks: ["menu_order", "date", "popularity"],             // offered in the segmented control
      },
      "golden-hive/hero-carousel":   { show: "summary", edit: false }, // later: slides editable
      "golden-hive/category-slider": { show: "summary", edit: false },
      "golden-hive/brand-marquee":   { show: "summary", edit: false },
      "*":                           { show: false },
    },
  },
  margins: { kind: "percent", min: 0, max: 100, skipSources: ["goldensneakers"], conflicts: "priority" },
  prices: { publish: "immediate" },
});
```

The plugin **independently** enforces what may be written. It does so in two ways:

- Its own allowlist (a filterable PHP array).
- The block's own `block.json` attribute types.

So the Hub config narrows what the UI offers, but can never widen what WordPress
accepts. Enabling title editing later means changing both allowlists by one line each.

---

## 6. Storefront side: golden-hive-blocks

### 6.1 Three new rail attributes

```
[gh_product_rail category="saldi-sneakers-outlet" limit="18" pin="1201,877,1543" exclude="990" fallback="menu_order"]
```

| Attribute | Meaning | Default |
|---|---|---|
| `pin` | product ids shown first, in this order (only those that are members and visible) | none, which is today's behaviour |
| `exclude` | product ids never shown in this rail. They stay in the category, and margins still apply. | none |
| `fallback` | order for everything after the pins. WooCommerce's own catalog orderings, the same options as the shop's "Ordina per" menu: `menu_order` · `date` · `popularity` · `price` · `price-desc` | `menu_order`, which is today's behaviour |

Effective order, one definition:

```
visible = publish ∧ in term (incl. children) ∧ not exclude-from-catalog
        ∧ (hide_out_of_stock ⇒ instock) ∧ id ∉ exclude
rail    = first `limit` of ( [pin ∩ visible, in pin order] ++ [visible \ pin, by fallback] )
```

Implementation, inside `ghb_get_carousel_products()`, only when `pin` / `exclude` /
`fallback` are present:

1. Get the visible ids (`fields => ids`), ordered through
   `WC()->query->get_catalog_ordering_args()` for the fallback.
2. Move the pinned ids to the front, keeping everything else in order.
3. Cut the list to `limit`.
4. Render with `post__in` + `orderby => post__in`.

The id list is cached in a transient keyed by the attributes and the stock option, and
invalidated on product save and stock change. Without the new attributes, the current
code path runs untouched.

### 6.2 Endpoints: namespace `wc-gh/v1`

All endpoints use Woo-key auth and require `manage_woocommerce`.

| Method | Route | Does |
|---|---|---|
| GET | `/capabilities` | plugin version and supported attributes. The Hub goes read-only if they're missing. |
| GET | `/homepage` | parses the front page's blocks. Returns rails (block path, attributes, parsed shortcode, the ids rendered now, card data) and other blocks as summaries. Also returns `page_id` and `modified`. |
| GET | `/rail?path=…&offset&count` | every member of a rail in effective order, plus hidden pinned ones with a reason (`outofstock`, `hidden`, `excluded`). Cards include id, sku, name, `woocommerce_thumbnail`, min price, stock status. |
| PUT | `/homepage/block` | writes allowlisted attributes of one block (§6.3). `dry_run: true` returns the diff only. |
| GET | `/homepage/history?path=…` | the block's attributes in recent revisions, for "Ripristina" |

### 6.3 Safe page writes

1. **Reject stale writes.** If `expected_modified` doesn't match the page's
   `post_modified_gmt`, return 409 and the editor reloads.
2. **Locate the block and check it.** Find it by `path`, assert `blockName`, and compare
   a hash of its current attributes with `expected_attrs_hash`. On mismatch, return 409.
3. **Build the new attributes.** Only allowlisted keys change. Values are validated:
   - ids are integers, at most 100 of them;
   - `fallback` must be one of the known values;
   - the types must match `block.json`.
4. **Edit the shortcode string without disturbing it.** Parse it with
   `shortcode_parse_atts()`, change or add only `pin` / `exclude` / `fallback`, and keep
   every other attribute and its order.
5. **Make a targeted replacement, never a whole-page rewrite.**
   - Serialize the old attributes with `serialize_block_attributes()` (WordPress's
     canonical escaping, the `"` seen in the markup).
   - Find `<!-- wp:golden-hive/shortcode-wrapper {old} /-->`, which **must occur exactly
     once**.
   - Swap in the new attributes. If the block isn't found exactly once, return 422 and
     write nothing.
6. **Save.** `wp_update_post` creates a revision. Purge the page cache (LiteSpeed, WP
   Rocket, W3TC hooks when present; Cloudflare depends on your setup, Q25). Return the
   new `modified` and the rendered ids.

### 6.4 Category pages follow their homepage rail (Q9)

On a category or brand archive's main query, when the visitor hasn't picked another
sort:

- find the first homepage rail whose single term is this term (the front page's parsed
  rails are cached, and the cache is invalidated when the page is saved);
- apply its pins as `FIELD(ID, …)` ordering via `posts_clauses`, so pagination keeps
  working;
- apply its exclusions.

Terms without a homepage rail keep today's order.

---

## 7. Membership (curated rails)

- **Curated rails** (Tendenza, Saldi, Offerte, Nuovi arrivi) stay category-driven.
  - This keeps one concept, "the product is in Saldi", behind the rail, the category page
    and the Saldi margin.
  - A hand-picked `ids` list would split those apart: "I added it to Saldi but the price
    didn't drop".
- **"+ Aggiungi"** opens a search sheet (live Woo REST `products?search=`). The editor
  assigns the category (live re-read, then `existing ∪ {term}`) and pins the product
  where it was dropped.
- **"Rimuovi da Saldi"** removes the category. The Hub warns if the product would be left
  with no category.
- **Brand rails** can't remove a brand. "Nascondi" uses `exclude`.

---

## 8. Prices and margin × taxonomy (engine)

### 8.1 Scope

`RuleScope` gains `storeCategory?` / `storeBrand?` (Woo slugs). Products carry their
term slugs, **ancestors included**, as `storeCategories` / `storeBrands`. So a "Nike" rule
covers Nike Off-White, unless a more specific rule takes it.

### 8.2 Precedence

Rules compare lexicographically:

```
key(rule) = [ tier, weight, listIndex ]
  tier   = 3 SKU · 2 store term · 1 everything else
  weight = today's SCOPE_WEIGHT sum
  ties   → the later rule wins (as today)
```

- **Full order**: lock > sale rule > SKU rule > section rule > brand/family/source
  rule.
- **Between section rules**, list order is the customer's priority list. A sub-brand's
  rule is inserted above its parent's by default.
- **Unchanged**: the whole-margin takeover, and field-by-field merging of the nets (€20
  minimum margin, outlier guard, rounding, anti-churn).
- **Effect on today's rules**: only rules whose weights add up to 10 or more (for
  example family + sub-family + name = 11) now lose to SKU rules, which is the
  documented intent.
- **GoldenSneakers**: section rules skip `source: goldensneakers`. The UI shows "prezzo
  dal fornitore".

### 8.3 Where products get their store axes (no new tables)

- `toStoreProduct()` keeps `categories` / `brands` (`[{ id, slug }]`), which Woo already
  sends in the pulled payload.
- At the end of a pull, the snapshot also stores both term trees (`model.terms`), for
  ancestor expansion.
- **Sync planning** enriches each product's axes before `buildPlan`.
- **The drawer and product sheet** use the same data.
- **Margins coverage** reads it too.

### 8.4 Margin sheet: preview, then apply

1. **Preview.** The Hub computes proposed prices for the rail term's SKUs under the draft
   rule: how many go up / down / stay the same, the average change, and the list.
2. **Apply.** It saves the rule and runs `startStoreSync(market, termSkus)` until done,
   then `applySync({ priceScope: "all", dryRun: false, sanitize: false, backfillGtins: false })`.

That's prices only, bounded by the term's size, and audited in `apply_audit`.

### 8.5 Product sheet: prices and locks

- **Editing a size's price** locks it (the existing `store_overrides`). "Salva e
  pubblica" runs the same prices-only sync for that one SKU.
- **Store-only and simple products** write directly (`updateStoreVariation`, plus a
  `PUT products/{id}` for simple products).
- **A price locked below cost** (under the ask or the feed's `offer_price`) shows a
  warning before it's saved.

---

## 9. Hub changes (files, not tables)

| Area | Change |
|---|---|
| Config | `src/config/hub.config.ts` + Zod schema (§5) |
| Woo client | `getHomepage()`, `getRail()`, `putHomepageBlock()`, `getBlockHistory()` on `wc-gh/v1`; `searchProducts()`; category assign/remove (live re-read) |
| Store pull | keep `categories` / `brands`; fetch both term trees into the snapshot |
| Engine | `storeCategory` / `storeBrand` scope, tiered comparator, GoldenSneakers guard |
| Server actions | `getVetrina`, `getRail`, `publishRail`, `restoreRail`, `searchProducts`, `addToRail` / `removeFromRail`, `saveProductPrices`, `previewTermMargin` / `applyTermMargin`, `listTermMargins` / `saveTermMarginPriority` |
| UI | `src/app/(vetrina)/…`: its own layout with a Konsta `App`; the root layout keeps html/theme/i18n; existing routes move under `(admin)` (URLs unchanged); nav from config |
| App install | `app/manifest.ts`, icons, `appleWebApp` metadata |
| Deps | `konsta`, `motion`, `react-modal-sheet`, `sonner` |

History is WordPress's revisions. Price runs stay in `apply_audit`. No migration is
needed.

---

## 10. Tests

- **Engine**:
  - store-term matching with ancestors;
  - tier precedence;
  - list-order priority;
  - the GoldenSneakers guard;
  - the safety nets still applying under a section margin.
- **Ordering**: a pure `effectiveRailOrder()` in TypeScript, for optimistic UI and
  previews. Its JSON cases are shared with a PHP test of the plugin helper.
- **Plugin writes** (PHP unit tests against real homepage markup):
  - shortcode attribute editing preserves every other attribute;
  - the targeted replacement matches exactly once;
  - a dry run returns the right diff;
  - 409 / 422 paths.
- **Membership**: assign/remove never drops a product's other categories.
- **Contract**: after every deploy, `capabilities` + a dry-run write on the live
  homepage.

---

## 11. Phasing

| Phase | Scope | Done when |
|---|---|---|
| 1 · See | Konsta spike; plugin `capabilities`, `homepage`, `rail`; Hub home + read-only rail view; manifest; nav from config | the Vetrina on a phone shows every rail exactly as the site renders it |
| 2 · Order | Plugin `pin` / `exclude` / `fallback`, `homepage/block`, `history`, archive-follows-rail; editor: grip drag, action sheet, publish bar, undo toast, restore | reorder on a phone → one tap → the homepage and category page match; restore works; Gutenberg shows the attributes |
| 3 · Price | Pull keeps terms; store-term scope + precedence + tests; product sheet with locks + immediate publish; margin sheet + margins list (priority, conflicts) | Saldi at 10% previews, then updates exactly Saldi's products; a lock goes live in one tap and survives the next full Sync |
| 4 · Fill | Search sheet; add/remove for curated rails | adding or removing never loses a product's other categories |
| 5 · Shape (config flip) | Titles, eyebrows, limits; hero slides, slider, marquee through the same endpoint | turning on a flag in `hub.config.ts` + the plugin allowlist makes it editable |

Phases 2 and 3 are independent and can run in either order. Phase 3 needs no plugin
deploy.

---

## 12. Open questions

1. **Reference image** (Q1): a screenshot never came through. If "attached" meant the
   page markup, this is closed.
2. **iPhone or Android?** It sets the Konsta theme default (`ios` / `material`).
3. **Q10: NUOVI ARRIVI.** It could become automatic: `fallback="date"` on a broad
   category shows the newest products with no manual tagging. You'd pin what must stay on
   top. Keep manual, or go automatic?
4. **Q19: Saldi.** Struck-through price (regular + sale), or just a lower price?
5. **Q22: the full Sync.** Who runs it, and how often, now that margins change from the
   phone? Should the scheduler push prices daily (prices only)?
6. **Store facts** (Q23–27):
   - number of products and terms;
   - rough share of StockX, GoldenSneakers and store-only products;
   - the page cache or CDN in front of the site;
   - whether "Nascondi prodotti esauriti" is on;
   - whether anyone reorders or recategorizes in WP admin.

Proposed and assumed unless you object:

- **Q11**: curated rails stay category-driven (§7).
- **Q12**: brand rails can hide products (`exclude`).

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| A write damages the homepage | allowlist + `block.json` validation + exact-once targeted replacement + stale-write rejection + revision; dry run in the contract check |
| The page cache serves the old homepage after a publish | purge hooks; "Vedi il sito" with a cache-busting parameter |
| Gutenberg and the Vetrina edit at the same time | `expected_modified` → 409 → the editor reloads with the latest page |
| Double margin on GoldenSneakers products | resolver guard + badge |
| A margin change moves many prices | preview first; bounded to the term; audited; restore by re-applying the previous % |
| The customer opens destructive tabs by URL | those tabs are off the nav by config; destructive runs stay dry-run-first |
| Konsta clashes with the Hub's Tailwind tokens | phase 1 spike, scoped to the `(vetrina)` layout |

---

## Appendix A: v0 (Hub-owned sections) — why not

v0 made each Woo term a "section" and put the order in term meta. The Hub kept six new
tables:

- a store mirror (terms, products, memberships);
- the homepage structure;
- per-term draft and published state;
- a publish log.

The rail query and the archives read the term meta.

It works, but it duplicates state WordPress already owns, and it needs scheduled pulls
to stay honest. It also gives no path to editing hero slides or the slider without new
machinery. B keeps the one piece v0 got right — prices and margins belong to the Hub —
and drops the rest.
