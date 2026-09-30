/** Dashboard skeleton — the homepage must paint instantly. */
export default function HomeLoading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 space-y-2">
        <div className="shimmer h-8 w-48 rounded bg-surface-2" />
        <div className="shimmer h-4 w-80 rounded bg-surface-2" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="shimmer h-44 rounded-xl border border-line bg-surface" />
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="shimmer h-40 rounded-xl border border-line bg-surface" />
        <div className="shimmer h-40 rounded-xl border border-line bg-surface" />
      </div>
    </main>
  );
}
