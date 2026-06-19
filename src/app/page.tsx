import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20">
      <div className="animate-fade-up">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted shadow-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          StockX → WooCommerce
        </span>
        <h1 className="mt-5 text-4xl font-bold tracking-tight">
          Reprice your catalog,{" "}
          <span className="text-accent-text">preview every change</span>.
        </h1>
        <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">
          Pull live StockX prices via KicksDB, match them to your store by EU size, and review a
          per-variant plan before anything ships. JSON round-trip — prices only, everything else
          preserved.
        </p>
        <div className="mt-7 flex items-center gap-3">
          <Link
            href="/preview"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-5 text-sm font-semibold text-accent-fg shadow-[0_10px_24px_-10px] shadow-accent/60 transition-transform hover:scale-[1.02] active:scale-[0.98]"
          >
            Open fetch &amp; preview
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
        </div>
      </div>
    </main>
  );
}
