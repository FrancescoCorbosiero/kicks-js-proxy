/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Starts the in-app sync scheduler (no-op in dev unless SCHEDULER=on) and,
 * with HEAP_WATCH=on, prints the heap into this console beside the request
 * log so a run that grows it can be read off the same output.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/server/scheduler");
    startScheduler();
    const { startHeapWatch } = await import("@/server/debug/heap-watch");
    startHeapWatch();
  }
}
