/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Starts the in-app sync scheduler (no-op in dev unless SCHEDULER=on).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/server/scheduler");
    startScheduler();
  }
}
