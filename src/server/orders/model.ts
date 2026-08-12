import { z } from "zod";

/**
 * Orders domain model — pure module (no DB, no HTTP), unit-tested.
 *
 * Normalizes raw WooCommerce REST orders into the compact shape the Orders
 * tab shows, and defines the LOCAL fulfillment workflow: the operational
 * status pipeline the operator drives from the tab, independent of the Woo
 * status (which stays read-only here — changes are mirrored to Woo manually,
 * and the tab flags orders whose local state is ahead of the store).
 *
 * The tracking trio (carrier / code / URL) and the carrier presets mirror the
 * golden-hive order meta box (_rp_em_tracking_code / _url / _carrier), so the
 * same data can later feed the "order shipped" email flow unchanged.
 */

/* ------------------------------------------------------------------ */
/* Local fulfillment workflow                                          */
/* ------------------------------------------------------------------ */

export const ORDER_STATUSES = ["new", "processing", "shipped", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(x: unknown): x is OrderStatus {
  return typeof x === "string" && (ORDER_STATUSES as readonly string[]).includes(x);
}

/** The one-click "advance" step per status — the big obvious button. */
export const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  new: "processing",
  processing: "shipped",
  shipped: "completed",
};

/** Common Italian carriers (same presets as the golden-hive meta box). */
export const CARRIERS = [
  "DHL",
  "BRT",
  "SDA",
  "Poste Italiane",
  "UPS",
  "FedEx",
  "TNT",
  "GLS",
  "InPost",
] as const;

/**
 * The local statuses that mean "done" from the operator's point of view and
 * the Woo statuses that already reflect them. When the local state is one of
 * these but the pulled Woo status is NOT in the matching set, the operator
 * still has to mirror the change in wp-admin — the tab shows a reminder badge.
 */
const WOO_MIRROR: Partial<Record<OrderStatus, string[]>> = {
  shipped: ["completed"],
  completed: ["completed"],
  cancelled: ["cancelled", "refunded", "failed", "trash"],
};

export function needsWooMirror(local: OrderStatus, wooStatus: string): boolean {
  const accepted = WOO_MIRROR[local];
  return accepted != null && !accepted.includes(wooStatus);
}

/* ------------------------------------------------------------------ */
/* Normalized order (what the snapshot rows store)                     */
/* ------------------------------------------------------------------ */

export interface OrderAddress {
  name: string; // recipient (shipping name, else billing name)
  street: string; // address_1 + address_2
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
}

export interface OrderItem {
  name: string;
  sku: string;
  size: string; // display value of a taglia/size meta, "" when absent
  quantity: number;
  total: number | null; // line total, major units
  image: string;
}

export interface OrderModel {
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
  createdAt: string; // ISO
  modifiedAt: string | null;
  raw: unknown;
}

/* ------------------------------------------------------------------ */
/* Woo REST → OrderModel                                               */
/* ------------------------------------------------------------------ */

const PersonSchema = z.looseObject({
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  company: z.string().nullish(),
  address_1: z.string().nullish(),
  address_2: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  postcode: z.string().nullish(),
  country: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
});

const LineItemSchema = z.looseObject({
  name: z.string().nullish(),
  sku: z.string().nullish(),
  quantity: z.number().nullish(),
  total: z.union([z.string(), z.number()]).nullish(),
  image: z.looseObject({ src: z.string().nullish() }).nullish(),
  meta_data: z
    .array(
      z.looseObject({
        key: z.string().nullish(),
        display_key: z.string().nullish(),
        value: z.unknown().nullish(),
        display_value: z.unknown().nullish(),
      }),
    )
    .nullish(),
});

const WooOrderSchema = z.looseObject({
  id: z.number(),
  number: z.union([z.string(), z.number()]).nullish(),
  status: z.string().nullish(),
  currency: z.string().nullish(),
  total: z.union([z.string(), z.number()]).nullish(),
  date_created: z.string().nullish(),
  date_modified: z.string().nullish(),
  customer_note: z.string().nullish(),
  payment_method_title: z.string().nullish(),
  billing: PersonSchema.nullish(),
  shipping: PersonSchema.nullish(),
  line_items: z.array(LineItemSchema).nullish(),
});

function toNumber(x: string | number | null | undefined): number | null {
  if (x == null) return null;
  const n = typeof x === "number" ? x : Number.parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function personName(p: z.infer<typeof PersonSchema> | null | undefined): string {
  return [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim();
}

/** A line item's size: the display value of any taglia/size attribute meta. */
function itemSize(item: z.infer<typeof LineItemSchema>): string {
  for (const m of item.meta_data ?? []) {
    const label = `${m.display_key ?? m.key ?? ""}`.toLowerCase();
    if (/taglia|size/.test(label) && !label.startsWith("_")) {
      const v = m.display_value ?? m.value;
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
  }
  return "";
}

/**
 * Normalize one raw Woo REST order. Returns null when the payload is not an
 * order at all (missing id) — callers count those as rejected, never throw.
 */
export function normalizeWooOrder(rawOrder: unknown): OrderModel | null {
  const parsed = WooOrderSchema.safeParse(rawOrder);
  if (!parsed.success) return null;
  const o = parsed.data;

  const billing = o.billing ?? null;
  const shipping = o.shipping ?? null;
  // Stores often leave the shipping block empty ("same as billing").
  const hasShipping = !!(shipping && (shipping.address_1 || shipping.city));
  const addr = hasShipping ? shipping! : (billing ?? {});

  return {
    id: o.id,
    number: o.number != null && String(o.number) !== "" ? String(o.number) : String(o.id),
    wooStatus: o.status ?? "",
    currency: o.currency ?? "EUR",
    total: toNumber(o.total),
    customerName: personName(billing) || personName(shipping),
    customerEmail: billing?.email ?? "",
    customerPhone: billing?.phone ?? shipping?.phone ?? "",
    customerNote: o.customer_note ?? "",
    paymentMethod: o.payment_method_title ?? "",
    shipping: {
      name: personName(shipping) || personName(billing),
      street: [addr.address_1, addr.address_2].filter(Boolean).join(", "),
      city: addr.city ?? "",
      state: addr.state ?? "",
      zip: addr.postcode ?? "",
      country: addr.country ?? "",
      phone: addr.phone ?? billing?.phone ?? "",
    },
    items: (o.line_items ?? []).map((it) => ({
      name: it.name ?? "",
      sku: it.sku ?? "",
      size: itemSize(it),
      quantity: it.quantity ?? 1,
      total: toNumber(it.total),
      image: it.image?.src ?? "",
    })),
    createdAt: o.date_created ?? new Date(0).toISOString(),
    modifiedAt: o.date_modified ?? null,
    raw: rawOrder,
  };
}

/** The shipping address as a copy-pastable block (courier forms, labels). */
export function formatAddress(a: OrderAddress): string {
  return [
    a.name,
    a.street,
    [a.zip, a.city, a.state].filter(Boolean).join(" "),
    a.country,
    a.phone,
  ]
    .filter((line) => line && line.trim() !== "")
    .join("\n");
}
