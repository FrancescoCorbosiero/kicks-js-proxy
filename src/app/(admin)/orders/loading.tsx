/** Instant skeleton while the orders list renders server-side. */
export default function OrdersLoading() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 space-y-2">
        <div className="shimmer h-3.5 w-36 rounded bg-surface-2" />
        <div className="shimmer h-8 w-40 rounded bg-surface-2" />
      </div>
      <div className="space-y-4">
        <div className="shimmer h-10 w-full rounded-xl border border-line bg-surface" />
        <div className="shimmer h-8 w-80 rounded-xl bg-surface-2" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="shimmer h-24 rounded-xl border border-line bg-surface" />
        ))}
      </div>
    </main>
  );
}
