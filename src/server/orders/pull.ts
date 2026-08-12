import "server-only";
import { getWooClient } from "@/server/woo/client";
import { normalizeWooOrder, type OrderModel } from "./model";
import { upsertOrders } from "./repo";

/**
 * The orders pull: fetch the most recent orders over Woo REST and refresh the
 * snapshot. Unlike the product pull (thousands of rows, cursor-driven) this is
 * a couple of requests — one shot inside a single server action is fine.
 *
 * Pulls newest-first regardless of Woo status: "open" is a LOCAL concept here
 * (the operator's workflow state), and recently-closed orders still matter for
 * tracking questions and refunds. Existing local workflow state is never
 * touched by a pull.
 */

/** Recent orders kept in the snapshot: newest PAGES × PER_PAGE. */
const PER_PAGE = 50;
const PAGES = 2;

export interface OrdersPullReport {
  fetched: number; // orders the API returned
  saved: number; // rows upserted (fetched minus unparseable)
  rejected: number; // payloads that were not orders
  totalOnStore: number | null; // X-WP-Total when Woo provides it
}

export async function pullRecentOrders(): Promise<OrdersPullReport> {
  const client = getWooClient(); // throws a friendly message when unconfigured

  const report: OrdersPullReport = { fetched: 0, saved: 0, rejected: 0, totalOnStore: null };
  const models: OrderModel[] = [];

  for (let page = 1; page <= PAGES; page++) {
    const { orders, total } = await client.getOrdersPage(page, PER_PAGE);
    report.totalOnStore = total ?? report.totalOnStore;
    report.fetched += orders.length;
    for (const raw of orders) {
      const model = normalizeWooOrder(raw);
      if (model) models.push(model);
      else report.rejected += 1;
    }
    if (orders.length < PER_PAGE) break; // last page
  }

  await upsertOrders(models);
  report.saved = models.length;
  return report;
}
