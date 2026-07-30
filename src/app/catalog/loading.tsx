/** Instant skeleton while the grid renders server-side — no frozen blank tab. */
export default function CatalogLoading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 space-y-2">
        <div className="shimmer h-3.5 w-36 rounded bg-surface-2" />
        <div className="shimmer h-8 w-56 rounded bg-surface-2" />
      </div>
      <div className="flex items-start gap-6">
        <div className="hidden w-52 shrink-0 lg:block">
          <div className="shimmer h-72 rounded-xl border border-line bg-surface" />
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          <div className="shimmer h-10 w-72 rounded-xl border border-line bg-surface" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-line bg-surface">
                <div className="shimmer aspect-square w-full bg-surface-2" />
                <div className="space-y-2 p-3">
                  <div className="shimmer h-3 w-1/2 rounded bg-surface-2" />
                  <div className="shimmer h-4 w-3/4 rounded bg-surface-2" />
                  <div className="shimmer h-3 w-2/3 rounded bg-surface-2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
