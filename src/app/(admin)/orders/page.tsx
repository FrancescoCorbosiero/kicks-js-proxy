import { OrdersWorkspace } from "@/components/orders/OrdersWorkspace";
import { DbUnavailable } from "@/components/DbUnavailable";
import { assertSchemaCurrent } from "@/server/db/probe";
import { getOrdersState } from "@/server/actions/orders";
import { getServerDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The Orders tab — the store's orders WITHOUT opening WooCommerce: pull the
 * recent orders over REST, then drive a local fulfillment workflow per order
 * (status pipeline, tracking details, notes). Nothing here writes to Woo; the
 * operator mirrors terminal states in wp-admin and the tab reminds them.
 */
export default async function OrdersPage() {
  const { t } = await getServerDictionary();

  let state;
  try {
    await assertSchemaCurrent();
    state = await getOrdersState();
  } catch (e) {
    return <DbUnavailable error={e} />;
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 animate-fade-up">
        <div className="flex items-center gap-2 text-xs font-medium text-faint">
          <span>{t.preview.crumbWorkspace}</span>
          <span>/</span>
          <span className="text-muted">{t.orders.title}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{t.orders.title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{t.orders.desc}</p>
      </div>
      <OrdersWorkspace initialState={state} />
    </main>
  );
}
