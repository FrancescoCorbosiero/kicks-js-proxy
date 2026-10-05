# Automatic categories (smart collections)

Status: **implemented** — Hub tab `/collections`, the Vetrina's rails and product
sheet, the scheduler. Runs on plain WooCommerce: no plugin change is needed.

Shopify's *automated collections*, on WooCommerce. A category gets a **rule** —
"tag is `saldi`", "brand is Nike and in stock", "added in the last 30 days" — and
from then on it holds **exactly** the products that meet it:

- a product that starts meeting the rule **joins** the category;
- a product that stops meeting it **leaves**, whoever put it there.

The shop assigns tags (brands, attributes…) wherever it is comfortable: WordPress
admin with its bulk edit, or the Vetrina's product sheet. The category follows on
its own — and so does everything built on it: the category page, the menus, and
the homepage rail that shows it. Arranging the homepage stops being the only way
to decide what a section shows.

- [1. How it works](#1-how-it-works)
- [2. The rule vocabulary](#2-the-rule-vocabulary)
- [3. Deciding](#3-deciding)
- [4. The safety net](#4-the-safety-net)
- [5. Staying in step with the store](#5-staying-in-step-with-the-store)
- [6. Where it shows](#6-where-it-shows)
- [7. Configuration](#7-configuration)
- [8. Things worth knowing](#8-things-worth-knowing)
- [9. Code map and tests](#9-code-map-and-tests)

## 1. How it works

```
 WordPress admin / Vetrina ──► product tags, brands, attributes change
                                   │
            every 5 min: "what changed since…?" (one light request)
                                   ▼
 store_index ──── the store's products: taxonomies + a few facts (Postgres)
      │
      ▼  decide every product against every rule (in memory, cheap)
 products whose categories must change
      │
      ▼  re-read THOSE products live, decide again on what the store says now,
      ▼  write their category lists (products/batch, 25 at a time)
 WooCommerce: the category's members ──► category page, menus, homepage rail
      │
      └─► collection_changes: every product moved, and what moved it
```

**The membership is written to the store as real categories**, not computed when a
page renders. Every page, filter, sitemap and product feed that reads categories
sees it, and nothing breaks if the Hub is down: the categories simply stop moving
until it is back. This also means the rules can live in the Hub — next to the
store index, the preview and the log — without touching `golden-hive-blocks`.

Only the categories a rule manages are ever touched. A product's other categories
stay, in their place.

## 2. The rule vocabulary

A rule is a list of conditions, matched **all** of them or **any** of them.

| Field | Operators | Value | Notes |
|---|---|---|---|
| Tag | is / is not | a product tag | stored by **id**: renaming a tag in WP admin keeps the rule |
| Brand | is / is not | a `product_brand` term | includes sub-brands ("Nike" covers "Nike Off-White") |
| Category | is / is not | a `product_cat` term | includes sub-categories; may read another automatic category |
| Attribute | is / is not | an attribute + one of its values | global attributes by id, a product's own by name |
| Product name | contains / does not contain | text | case-insensitive |
| Price | above / below | € | the product's current price (the lowest, with sizes) |
| On sale | yes / no | — | WooCommerce's `on_sale` |
| Availability | in stock / sold out | — | back-orderable counts as in stock |
| Added to the store | in the last / more than N days | days | moves products with no edit at all |

A rule with no conditions matches nothing (and cannot be saved). A tag that does
not exist yet can be typed in the editor: it is created on the store when the rule
is saved.

## 3. Deciding

`core/collections.ts` decides **one product at a time**, against every enabled
rule, in **dependency order**: a rule that reads another rule's category ("in
Saldi and brand Nike") is decided after it, so in one pass it sees that category as
it *will* be. Two cases cannot be decided and are refused when saving (and left
alone if the category tree changes under them later):

- **a loop** — rule A reads B's category and B reads A's;
- **a rule reading its own category**, or a parent of it. "In Saldi" holds for
  anything in a sub-category of Saldi too, so a sub-category with the rule "in
  Saldi" would keep every product that ever got in. Write its rule directly
  instead ("tag saldi and brand Nike").

## 4. The safety net

A rule is data, and data breaks: a tag deleted in WP admin, an attribute value
renamed, a typo saved by mistake — and the category empties itself on the next
run, taking the homepage rail with it. So **an automatic run**:

- **never empties a category** that has products;
- **never moves more than `COLLECTIONS_MAX_CHANGES`** products (default 200) in
  or out of one category at once.

Either case is **held**: nothing is written for that category, the Hub's tab and
the Vetrina say why and what would change, and a person confirms it ("Conferma e
applica"). A change made by hand — saving a rule after its preview, confirming a
held change — is its own confirmation. A category reading a held one is judged
against it as it stands, not against the change that did not happen.

Other nets:

- **Preview before saving.** The editor shows how many products the category
  holds now and after, who joins and who leaves (named), products that would be
  left with no category at all (WooCommerce files those under "Senza categoria"),
  and that hand-placed products not meeting the rule will leave.
- **Live re-read.** Every product about to be written is read again from the store
  and decided on that, so a stale index can cost an unnecessary read, never a
  wrong write.
- **A refused product** (the store answered with an error) is logged and left alone
  by the automatic runs for an hour.
- **One run at a time.** Checks, full reads, confirmations and product edits queue
  up; two decisions never write the same product from different readings.

## 5. Staying in step with the store

`store_index` is a light copy of the store: one row per product (every status but
the bin), with its categories, tags, brands, attributes, price, on-sale and stock
status, and creation and modification dates.

| Run | When | What it reads |
|---|---|---|
| **Check** | every `SCHEDULER_COLLECTIONS_MINUTES` (default 5) | products modified since the newest change the index holds (`modified_after`), usually none: one request |
| **Full read** | the daily sync; the tab's "Rileggi"; the first check after the server starts, and every check until one gets through | every product, `_fields`-trimmed, 100 per request |
| **Live re-read** | before every write | exactly the products about to be written |

A check only ever adds what changed, so an index left incomplete — a full read
cut short by an error, a crash, a deploy — would stay so until the next daily read.
That is why each server process starts with a full read, and keeps reading whole
until one gets through.

The check starts ten minutes before the newest change it holds (same-second edits,
clocks). A store that ignores `modified_after` (WooCommerce older than 5.8, or a
plugin stripping it) is noticed — it answers with everything — and from then on
the daily full read keeps the index fresh. More changes than a check reads (a CSV
import of thousands) trigger a full read. A full read is also how the index learns
that a product was binned, or changed without its modified time moving.

Deciding runs on every check even when nothing changed: "added in the last 30
days" moves products that nobody touched.

**Nothing reaches the store while no category is automatic.**

## 6. Where it shows

**Hub → Categorie automatiche (`/collections`)**, in the dock's setup menu:

- what the index holds and when it was read, and "Rileggi tutto il negozio";
- every rule in words ("Tag «saldi» e disponibile"), its members, its state
  (active, paused, waiting for a confirmation, needs a look) and a confirm button
  for held changes;
- the editor: category (existing, or a new one created on save), all/any, the
  conditions with values picked from the store's own terms, and the live preview;
- the log: every product that joined or left, when, and what moved it (the
  automatic check, a rule saved, a product's tags edited).

**Vetrina**, for the shop's owner on the phone:

- the home screen marks the rails whose category is automatic, with the rule;
- a rail showing one category has a card: *Rendi automatica* opens the same
  editor in a bottom sheet (same checks, same preview); once automatic, the card
  shows the rule and the members, and the section reloads when products moved.
  Pins and hides keep working on top: the rule decides *who* is in the section,
  the rail editor decides the *order*;
- the product sheet edits the product's **tags**: saved on the store, the product
  decided at once — "Ora è in: Saldi outlet" / "Uscito da: …" — and the section
  reloads.

**Feeds tab**: the scheduler card shows the check's cadence, its last run and any
error.

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCHEDULER_COLLECTIONS_MINUTES` | `5` | minutes between checks; `0` = only in the daily sync |
| `COLLECTIONS_MAX_CHANGES` | `200` | most products an automatic run moves in or out of one category |

The check needs the scheduler (on in production). With `SCHEDULER=off`, categories
move when a rule is saved or confirmed, on "Rileggi", or when the tab is opened.

**Demo mode.** With `VETRINA_SOURCE=fixture` the rules act on the Vetrina's demo
shop (which gained term ids and a few tags for it), so the whole loop — rule,
preview, apply, rail, tags — can be tried without a site. Nothing is written
anywhere, and a restart puts everything back.

## 8. Things worth knowing

- **Sub-categories are not managed.** A rule decides who is *directly* in its
  category. WooCommerce's category page (and the homepage rail) also show the
  products of its sub-categories.
- **A product left with no category** is filed by WooCommerce under its default
  category ("Senza categoria"); the preview counts them.
- **A category belongs to one rule.** Deleting a rule leaves the category as it is,
  with its current products: it is filled by hand again. The category itself is
  never deleted.
- **Pausing** freezes a category: nothing joins, nothing leaves.
- **The Publisher** still files new products under the category the Taxonomies tab
  resolves; an automatic category then takes them in or lets them go at the next
  check, like any other product.
- **Concurrent edits.** A product saved in WP admin between the live re-read and
  the write (seconds) can see its categories set to the re-read list.
- **One app instance.** The run queue is in-process, like the scheduler.
- **Not (yet) real time.** Changes made in WP admin are seen within the check's
  cadence. A WooCommerce webhook (`product.updated`) could make it immediate; it
  needs an Authelia bypass for its endpoint, so it is left for later. Tags edited
  from the Vetrina are decided at once.

## 9. Code map and tests

| Where | What |
|---|---|
| `core/collections.ts` | the vocabulary, matching, dependency order, loops, decisions, the safety net, the preview, rule checks — pure |
| `src/server/collections/runner.ts` | the runs: check, full read, live re-read and write, the queue, product tags |
| `src/server/collections/service.ts` | what the pages read, check and save |
| `src/server/collections/repo.ts` | `smart_collections`, `store_index`, `collection_changes` |
| `src/server/collections/store.ts`, `fixture-client.ts` | the real store, or the demo shop |
| `src/server/woo/client.ts` | `getProductIndexPage`, `batchUpdateProducts`, tags |
| `src/components/collections/` | the editor (shared by the Hub and the Vetrina), preview, page |
| `src/components/vetrina/CollectionSheet.tsx`, `TagsSection.tsx` | the Vetrina's sheet and tags |
| `drizzle/0018_*.sql` | the three tables |

Tests:

- `core/__tests__/collections.test.ts` — every condition, ordering, loops, the
  safety net (including a reader of a held category), previews, rule checks;
- `src/server/collections/index-rows.test.ts` — the store's answer as index rows;
- `src/server/collections/runner.db.test.ts` — the runs against real SQL and a
  stand-in store: first read, checks, stale index vs live store, held and
  confirmed changes, dependent rules, missing categories, refused products, a store
  ignoring `modified_after`, a check overflowing into a full read, a full read
  failing half-way and resumed, binned products, product tags. Opt-in, like the other DB suites:

  ```bash
  RUN_DB_TESTS=1 DATABASE_URL=postgres://…@localhost:…/… REDIS_URL=… npm test
  ```
