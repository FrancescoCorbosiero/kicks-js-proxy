import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">kicks-js-proxy</h1>
      <p className="mt-2 text-sm text-neutral-600">
        StockX → WooCommerce repricing &amp; sync.
      </p>
      <Link
        href="/preview"
        className="mt-6 inline-flex h-9 items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800"
      >
        Open fetch &amp; preview →
      </Link>
    </main>
  );
}
