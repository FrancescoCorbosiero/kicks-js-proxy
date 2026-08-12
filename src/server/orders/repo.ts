import "server-only";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { orderWorkflow, storeOrders, type OrderWorkflowRow } from "@/server/db/schema";
import { chunkArray } from "@/lib/chunk";
import {
  isOrderStatus,
  type OrderAddress,
  type OrderItem,
  type OrderModel,
  type OrderStatus,
} from "./model";

/**
 * Orders persistence: the pulled snapshot (store_orders, refreshed wholesale)
 * and the local workflow state (order_workflow, written only by the operator —
 * a re-pull never touches it). Reads join the two into the view the tab shows.
 */

/** One order as the Orders tab consumes it: snapshot + local workflow state. */
export interface OrderView {
  id: number;
  number: string;
  wooStatus: string;
  currency: string;
  total: number | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerNote: string;
  paymentMethod: string;
  shipping: OrderAddress;
  items: OrderItem[];
  createdAt: string;
  pulledAt: string;
  // Local workflow (defaults when the operator hasn't touched the order yet).
  status: OrderStatus;
  carrier: string;
  trackingCode: string;
  trackingUrl: string;
  note: string;
  statusChangedAt: string | null;
}

/** Upsert pulled orders into the snapshot. Chunked like every bulk writer. */
export async function upsertOrders(orders: OrderModel[]): Promise<void> {
  if (orders.length === 0) return;
  const now = new Date();
  const values = orders.map((o) => ({
    id: o.id,
    number: o.number,
    wooStatus: o.wooStatus,
    currency: o.currency,
    total: o.total,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    customerPhone: o.customerPhone,
    customerNote: o.customerNote,
    paymentMethod: o.paymentMethod,
    shipping: o.shipping,
    items: o.items,
    raw: o.raw,
    createdAt: new Date(o.createdAt),
    modifiedAt: o.modifiedAt ? new Date(o.modifiedAt) : null,
    pulledAt: now,
  }));
  for (const chunk of chunkArray(values, 200)) {
    await db
      .insert(storeOrders)
      .values(chunk)
      .onConflictDoUpdate({
        target: storeOrders.id,
        set: {
          number: sql`excluded.number`,
          wooStatus: sql`excluded.woo_status`,
          currency: sql`excluded.currency`,
          total: sql`excluded.total`,
          customerName: sql`excluded.customer_name`,
          customerEmail: sql`excluded.customer_email`,
          customerPhone: sql`excluded.customer_phone`,
          customerNote: sql`excluded.customer_note`,
          paymentMethod: sql`excluded.payment_method`,
          shipping: sql`excluded.shipping`,
          items: sql`excluded.items`,
          raw: sql`excluded.raw`,
          createdAt: sql`excluded.created_at`,
          modifiedAt: sql`excluded.modified_at`,
          pulledAt: sql`excluded.pulled_at`,
        },
      });
  }
}

/** When the snapshot was last refreshed (max pulled_at), or null when empty. */
export async function lastPulledAt(): Promise<string | null> {
  const rows = await db
    .select({ at: sql<Date | null>`max(${storeOrders.pulledAt})` })
    .from(storeOrders);
  return rows[0]?.at ? new Date(rows[0].at).toISOString() : null;
}

function toView(
  o: typeof storeOrders.$inferSelect,
  w: OrderWorkflowRow | null,
): OrderView {
  return {
    id: o.id,
    number: o.number,
    wooStatus: o.wooStatus,
    currency: o.currency,
    total: o.total,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    customerPhone: o.customerPhone,
    customerNote: o.customerNote,
    paymentMethod: o.paymentMethod,
    shipping: o.shipping as OrderAddress,
    items: o.items as OrderItem[],
    createdAt: o.createdAt.toISOString(),
    pulledAt: o.pulledAt.toISOString(),
    status: w && isOrderStatus(w.status) ? w.status : "new",
    carrier: w?.carrier ?? "",
    trackingCode: w?.trackingCode ?? "",
    trackingUrl: w?.trackingUrl ?? "",
    note: w?.note ?? "",
    statusChangedAt: w?.statusChangedAt ? w.statusChangedAt.toISOString() : null,
  };
}

/**
 * Every snapshot order joined with its workflow state, newest first. The
 * whole set is loaded (an operator-scale store: the pull keeps ~100 recent
 * orders); filtering/search happen client-side in the workspace.
 */
export async function listOrders(): Promise<OrderView[]> {
  const orders = await db.select().from(storeOrders).orderBy(desc(storeOrders.createdAt));
  if (orders.length === 0) return [];
  const workflows = await db
    .select()
    .from(orderWorkflow)
    .where(inArray(orderWorkflow.orderId, orders.map((o) => o.id)));
  const byId = new Map(workflows.map((w) => [w.orderId, w]));
  return orders.map((o) => toView(o, byId.get(o.id) ?? null));
}

/** True when the order exists in the snapshot (workflow writes require it). */
export async function orderExists(orderId: number): Promise<boolean> {
  const rows = await db
    .select({ id: storeOrders.id })
    .from(storeOrders)
    .where(eq(storeOrders.id, orderId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Seed workflow rows for orders that have NONE yet (first pull of settled
 * history: Woo-completed orders start as concluso, cancelled as annullato).
 * DO NOTHING on conflict — an existing row is the operator's state.
 */
export async function seedWorkflowStatuses(
  entries: { orderId: number; status: OrderStatus }[],
): Promise<void> {
  if (entries.length === 0) return;
  const now = new Date();
  for (const chunk of chunkArray(entries, 200)) {
    await db
      .insert(orderWorkflow)
      .values(chunk.map((e) => ({ orderId: e.orderId, status: e.status, updatedAt: now })))
      .onConflictDoNothing({ target: orderWorkflow.orderId });
  }
}

/** Set the local fulfillment status (stamps statusChangedAt). */
export async function setWorkflowStatus(orderId: number, status: OrderStatus): Promise<void> {
  const now = new Date();
  await db
    .insert(orderWorkflow)
    .values({ orderId, status, statusChangedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: orderWorkflow.orderId,
      set: { status, statusChangedAt: now, updatedAt: now },
    });
}

/** Set the tracking trio (carrier / code / URL) without touching the status. */
export async function setWorkflowTracking(
  orderId: number,
  tracking: { carrier: string; trackingCode: string; trackingUrl: string },
): Promise<void> {
  const now = new Date();
  await db
    .insert(orderWorkflow)
    .values({ orderId, ...tracking, updatedAt: now })
    .onConflictDoUpdate({
      target: orderWorkflow.orderId,
      set: { ...tracking, updatedAt: now },
    });
}

/** Set the operator note. */
export async function setWorkflowNote(orderId: number, note: string): Promise<void> {
  const now = new Date();
  await db
    .insert(orderWorkflow)
    .values({ orderId, note, updatedAt: now })
    .onConflictDoUpdate({
      target: orderWorkflow.orderId,
      set: { note, updatedAt: now },
    });
}
