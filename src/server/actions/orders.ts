"use server";

import { z } from "zod";
import { wooConfigured } from "@/server/woo/client";
import { ORDER_STATUSES } from "@/server/orders/model";
import {
  lastPulledAt,
  listOrders,
  orderExists,
  setWorkflowNote,
  setWorkflowStatus,
  setWorkflowTracking,
  type OrderView,
} from "@/server/orders/repo";
import { pullRecentOrders, type OrdersPullReport } from "@/server/orders/pull";

/**
 * Orders tab actions. Reads join the pulled snapshot with the local workflow;
 * writes touch ONLY the local workflow (order_workflow) — nothing here calls
 * a Woo write endpoint. The operator mirrors state to wp-admin manually and
 * the UI flags orders whose local state is ahead of the store.
 */

export interface OrdersState {
  wooConfigured: boolean;
  lastPulledAt: string | null;
  orders: OrderView[];
}

export async function getOrdersState(): Promise<OrdersState> {
  const [pulled, orders] = await Promise.all([
    lastPulledAt().catch(() => null),
    listOrders().catch(() => [] as OrderView[]),
  ]);
  return { wooConfigured: wooConfigured(), lastPulledAt: pulled, orders };
}

export interface OrdersActionResult {
  ok: boolean;
  error?: string;
  /** Fresh state after a pull, so the client swaps its list in one go. */
  state?: OrdersState;
  report?: OrdersPullReport;
}

export async function pullOrders(): Promise<OrdersActionResult> {
  try {
    const report = await pullRecentOrders();
    return { ok: true, report, state: await getOrdersState() };
  } catch (e) {
    const cause = (e as { cause?: { message?: string } })?.cause;
    return { ok: false, error: cause?.message ?? (e instanceof Error ? e.message : String(e)) };
  }
}

const StatusSchema = z.object({
  orderId: z.number().int().positive(),
  status: z.enum(ORDER_STATUSES),
});

export async function setOrderStatus(
  input: z.infer<typeof StatusSchema>,
): Promise<OrdersActionResult> {
  const parsed = StatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    if (!(await orderExists(parsed.data.orderId))) return { ok: false, error: "unknown order" };
    await setWorkflowStatus(parsed.data.orderId, parsed.data.status);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const TrackingSchema = z.object({
  orderId: z.number().int().positive(),
  carrier: z.string().max(64).default(""),
  trackingCode: z.string().max(128).default(""),
  trackingUrl: z
    .string()
    .max(512)
    .default("")
    .refine((v) => v === "" || /^https?:\/\//.test(v), { message: "invalid tracking URL" }),
});

export async function setOrderTracking(
  input: z.input<typeof TrackingSchema>,
): Promise<OrdersActionResult> {
  const parsed = TrackingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  try {
    if (!(await orderExists(parsed.data.orderId))) return { ok: false, error: "unknown order" };
    const { orderId, carrier, trackingCode, trackingUrl } = parsed.data;
    await setWorkflowTracking(orderId, {
      carrier: carrier.trim(),
      trackingCode: trackingCode.trim(),
      trackingUrl: trackingUrl.trim(),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const NoteSchema = z.object({
  orderId: z.number().int().positive(),
  note: z.string().max(2000),
});

export async function setOrderNote(
  input: z.infer<typeof NoteSchema>,
): Promise<OrdersActionResult> {
  const parsed = NoteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    if (!(await orderExists(parsed.data.orderId))) return { ok: false, error: "unknown order" };
    await setWorkflowNote(parsed.data.orderId, parsed.data.note.trim());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
