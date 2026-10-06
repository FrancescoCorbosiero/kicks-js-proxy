# Store Hub and Hive Suite: where a feature lives

Status: **decision record** — the line between this repo (Store Hub) and
[hive-commerce](https://github.com/FrancescoCorbosiero/hive-commerce) (the plan
for Hive Suite, a WordPress plugin), and what follows from it.

Both projects describe a sync engine, a KicksDB integration, pricing rules, a
scheduler, provenance and smart categories. Built twice, they would write the same
prices to the same store, each undoing the other every cycle. So the line is not
"which repo has the feature": it is **who is allowed to write product data**.

- [1. The rule](#1-the-rule)
- [2. Why the Hub](#2-why-the-hub)
- [3. hive-commerce's inventory, feature by feature](#3-hive-commerces-inventory-feature-by-feature)
- [4. What the plugin is for](#4-what-the-plugin-is-for)
- [5. How the two meet](#5-how-the-two-meet)
- [6. What comes next in the Hub](#6-what-comes-next-in-the-hub)

## 1. The rule

**One writer of product data: the Hub.** What a product is (sizes, identity at
creation), what it costs, how many are available and which categories a rule puts
it in are decided and written by the Hub, and only by the Hub. WordPress stays the
store: it holds the data, renders it, and takes the orders.

To place a feature, ask in this order:

| Question | If yes |
|---|---|
| Does it decide a product's existence, sizes, price, stock, or rule-made category? | **Hub** |
| Must it run inside a WordPress request or hook — an order screen's metabox, `wp_mail` on an order status, the media library's internals, the theme? | **Plugin** |
| Is it the storefront's presentation (homepage sections, blocks)? | The **plugin renders** it; the **Hub edits** it through the plugin's REST endpoints — exactly how the Vetrina and `golden-hive-blocks` work today |
| Does the Hub need to know at once that something happened on the store? | **WooCommerce webhooks to the Hub** — configuration, not plugin code; polling stays the fallback |

People keep editing in WordPress whatever the Hub does not own: descriptions, SEO,
extra photos, sale prices (the Hub's sale rule leaves them alone), menus. And when
someone edits a price the Hub does own, the Hub notices and keeps it instead of
writing over it (see [README → Sync](../README.md#tabs)): the shop can always use
WordPress, the Hub never fights it silently.

## 2. Why the Hub

hive-commerce's own decision record (D1) chose a plugin because the standalone
importer it replaced was the buggy one: REST round-trips, state files drifting from
the store, no access to WooCommerce internals. Those were real — and each has since
been met in the Hub, one incident at a time:

| The plugin's argument | Where the Hub stands |
|---|---|
| REST batch caps and timeouts | Cursor-driven pulls and stepped syncs that survive any request timeout; Publish sized to Cloudflare's 100 seconds; per-parent variation batches |
| State files drifting from the store | One snapshot in Postgres, patched after every write under a lock; a live SKU lookup before every create; a live re-read before every unattended write |
| A 5K refresh in minutes, not hours | The plan writes only differences (no-op and anti-churn rows cost nothing); unattended runs write prices and stock only |
| Photos sideloaded inside the request | A photo queue: products are created hidden and go on sale with their first photo |
| WP-Cron fires only with traffic (D6) | An in-process scheduler with catch-up, retries and heartbeat URLs |

And the Hub has what a plugin could only rebuild: a multi-source catalog in Postgres
(KicksDB, the supplier feed and a mirror of the store) that heavy queries can walk,
an app of its own for the shop's owner (the Vetrina), sign-in per shop, and
**independence** — the store keeps selling when the Hub is down, and the Hub keeps
its state when WordPress is down.

The Hub is built, deployed and running every quarter of an hour. Hive Suite's sync
half is a plan. Building it would mean two engines on one store.

## 3. hive-commerce's inventory, feature by feature

Letters follow `docs/02-FEATURES.md` there. **Hub ✓** = in the Hub today;
**Hub →** = belongs in the Hub, not built yet (see [section 6](#6-what-comes-next-in-the-hub));
**Plugin** = belongs in WordPress; **Drop** = not worth building in either.

### A. Sync engine

| Feature | Where | Notes |
|---|---|---|
| Source registry, typed config | Hub ✓ / → | The Feeds tab (KicksDB re-pricing, GoldenSneakers). More sources: section 6 |
| JSON source, GoldenSneakers flavor | Hub ✓ | API or upload; validate everything first, abort on empty, deactivate-never-delete; product-level ownership |
| JSON/CSV generic, StockFirmati flavor | Hub → | `feed_items` is already keyed by feed; ownership is the part to generalize |
| Markup rules on feed fields (I1, I2) | Hub ✓ | Scoped margin rules (source, brand, family, SKU, size) applied to the source price, never to the store's: idempotent by construction. GS prices pass through |
| 3-bucket diff, fast stock patch (I3) | Hub ✓ | Plan rows update / create / no-op / skip; stock-only updates; unattended runs write prices and stock only |
| Mapping entity, visual mapper | Hub → | Together with generic sources, not before |
| Pipelines (pre-checks, import rules, post-checks) | Drop | The Publisher's checks and the repair scan cover them; an editor earns its keep only with several heterogeneous sources |
| Operations on existing products | Hub → | As bulk actions (section 6) |
| Rules: selection + operations | Hub ✓ / → | Automatic categories are the first rule type; bulk actions the second |
| Materializer | Hub ✓ | Publish: hidden create, canonical EU sizes, live SKU check, photo queue |
| Jobs on cron expressions | Hub ✓ | Fixed cadences in env, catch-up, retries, heartbeats. A cron editor is not needed |
| Run audit and retention (I17, I20) | Hub ✓ | `apply_audit`, `ingestion_runs`, `scheduler_runs`; trimmed daily |
| Resilience: cursors, resume (I12) | Hub ✓ | Pull, stepped sync, publish batches |
| Dry run end to end | Hub ✓ | Sync, Publish, rebuild, repair |
| Cockpit | Hub ✓ | Dashboard and the dock |
| `project.json` config as code | Hub → | One Hub per shop: copying margins and rules between shops is the use |

### B. KicksDB

| Feature | Where | Notes |
|---|---|---|
| Client, pricing extraction (I8) | Hub ✓ | Further along than the plan: conflicting same-tier rows, poisoned payloads bisected, "no products found" read as an answer, the outlier guard |
| Formula, tiers, floor, rounding | Hub ✓ | Banded markup, fixed margins, guaranteed minimum margin, charm rounding |
| Lookup, refresh pricing | Hub ✓ | Import tab, the KicksDB refresh feed (50 SKUs a call) |
| Normalizer, profiles | Hub ✓ | Catalog metadata, the title classifier, taxonomy rules |
| Discover (search, cherry-pick) | Hub → | The preview's query mode is the seed |
| Price webhooks | Hub → | One route past Authelia, signature-checked; the refresh stays the fallback |

### C. Conflict and provenance (I7)

| Feature | Where | Notes |
|---|---|---|
| Who owns a product | Hub ✓ | Manual pin > supplier feed > KicksDB |
| Manual is sacred | Hub ✓ | Locks, the sale rule, and prices changed on WordPress: kept, listed, decided by a person |
| Per-slice rules editor | Drop | The slices follow from the sources (the feed owns price and stock; KicksDB only price) |

### D–F. Filter & Act, product tools, catalog

| Feature | Where | Notes |
|---|---|---|
| Filter & Act, bulk actions | Hub → | `store_index` already holds every product's facets |
| Sorter (`menu_order`) | Hub → | As an order for automatic categories, next to the Vetrina's pins |
| Inline editor | Split | Price, stock and tags in the Hub (drawer, Vetrina); the full product form stays WordPress's own editor |
| Taxonomy rules | Hub ✓ | Taxonomies tab |
| Smart taxonomy | Hub ✓ | Automatic categories, better than the plan: persisted rules, held changes, a log |
| Tax query, counts | Hub → | Over `store_index`, when a screen needs it |
| Navigation menus | Plugin | WordPress's menu editor already does it |
| Round-trip export/import | Hub ✓ | The hidden `/preview` file flow |

### G–I. Media, email, tools

| Feature | Where | Notes |
|---|---|---|
| Product photos at creation | Hub ✓ | The photo queue |
| Media usage index, safe cleanup, whitelist | Plugin | Needs the library's internals: post content, attachment metadata |
| Email: brand, templates, campaigns | Plugin | `wp_mail`, the site's identity |
| Transactional emails, order metabox | Plugin | Fired by WooCommerce order hooks |
| HTTP client tab | Drop | A developer's tool |
| Nuclear cleanup | Plugin (WP-CLI) | Never from the Hub |
| Uninstall hygiene, system status | Plugin | For the plugin's own tables and cron |

## 4. What the plugin is for

What is left for Hive Suite is the part of its plan that truly needs WordPress, and
its D1 argument holds for exactly that part:

- **Email** — brand, templates, campaigns, transactional events, the order metabox,
  the log (hive-commerce H, invariant I14).
- **Media hygiene** — usage index, whitelist, safe cleanup (G, I16).
- **Storefront** — the blocks and endpoints the Vetrina edits through
  (`golden-hive-blocks` today; it can stay its own plugin or be folded in).

Its sync engine, KicksDB module, conflict engine, Filter & Act and smart taxonomy
should leave its plan (the scope list in its `CLAUDE.md`), not be ported here: the
Hub has them, or has their place reserved.

## 5. How the two meet

| Direction | How |
|---|---|
| Hub → store: products, prices, stock, categories | WooCommerce REST (as today) |
| Hub → storefront: homepage sections | The plugin's REST endpoints (`wc-gh/v1`, as today) |
| Hub → email: an order shipped | The Orders tab writes carrier, tracking code and URL into the order's meta (`_rp_em_tracking_*`, the plugin's own keys) and moves its status; the plugin's transactional email fires on that status. Today the operator copies them by hand |
| Store → Hub: something changed | WooCommerce webhooks (`product.updated`, `order.created`) to one Hub route, signature-checked, past Authelia; the 5- and 15-minute polls stay as the safety net |
| A person in WordPress → a Hub-owned price | Kept, listed under "Prices changed on WordPress", decided in the Hub or the Vetrina |

## 6. What comes next in the Hub

For the product sync, in order of value:

1. **Generic supplier feeds** — a CSV or JSON URL, a column mapping (SKU, size,
   price or cost, quantity, name, brand, photo, barcode), its own margin rule
   (scope `source`) and cadence; StockFirmati as the first. Ownership becomes "the
   first active feed by priority" instead of GoldenSneakers by name.
2. **Bulk actions** over the store index — status, sale percentage, stock, tags —
   with the automatic categories' discipline: a preview naming every product, held
   changes past a size, a log.
3. **Oversell guard** — the feed's quantity minus the store's open orders not yet
   bought from the supplier. It needs one more step in the Orders workflow
   ("ordered from the supplier").
4. **Webhooks in** — the store index and the live re-read moved by the store's own
   events instead of polls.
5. **Rules as code** — export and import margins, taxonomy rules and automatic
   categories between shops.
6. **KicksDB Discover and price webhooks.**
