import { NextResponse } from "next/server";
import { writeHeapSnapshot } from "node:v8";
import { join } from "node:path";

export const dynamic = "force-dynamic";
// Writing a snapshot of a multi-GB heap pauses the process and takes a while.
export const maxDuration = 300;

/**
 * Heap diagnostics for a dev server that is running out of memory.
 *
 * Why this exists rather than `--heapsnapshot-near-heap-limit`: that flag asks
 * V8 to serialize the heap AT the heap limit, which is the one moment there is
 * no room left to do it. It dies with "Out of memory: HashMap::Initialize"
 * inside HeapProfiler::TakeHeapSnapshot and you get no file — the failure the
 * flag was supposed to diagnose, now with the profiler's stack on top.
 *
 * Taking it ON PURPOSE, while the process is fat but still has headroom, always
 * works. Poll GET until heapUsed is high (say 2.5 GB of a 4 GB cap), then POST.
 *
 *   curl http://localhost:3000/api/debug/heap
 *   curl -X POST http://localhost:3000/api/debug/heap
 *
 * Open the resulting .heapsnapshot in Chrome: F12 -> Memory -> Load, then sort
 * by Retained Size. The top row is what is holding the memory, and "Retainers"
 * at the bottom shows the chain that keeps it alive.
 *
 * DEVELOPMENT ONLY. A snapshot stops the world for seconds and writes a file
 * the size of the heap, so this must never be reachable on a live deployment.
 */
function devOnly(): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return null;
}

const mb = (n: number) => Math.round(n / 1024 / 1024);

export async function GET() {
  const blocked = devOnly();
  if (blocked) return blocked;

  const m = process.memoryUsage();
  return NextResponse.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    heapUsedMB: mb(m.heapUsed),
    heapTotalMB: mb(m.heapTotal),
    rssMB: mb(m.rss),
    externalMB: mb(m.external),
    arrayBuffersMB: mb(m.arrayBuffers),
    hint: "POST here to write a .heapsnapshot. Do it while heapUsed is high but below the cap.",
  });
}

export async function POST() {
  const blocked = devOnly();
  if (blocked) return blocked;

  const before = process.memoryUsage();
  try {
    // Written into the project root so it is easy to find on Windows too.
    const file = writeHeapSnapshot(
      join(process.cwd(), `heap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`),
    );
    return NextResponse.json({
      ok: true,
      file,
      heapUsedMB: mb(before.heapUsed),
      rssMB: mb(before.rss),
      next: "Open it in Chrome DevTools: F12 -> Memory -> Load -> sort by Retained Size.",
    });
  } catch (e) {
    // The usual cause is no headroom left: the snapshot needs memory of its own.
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        heapUsedMB: mb(before.heapUsed),
        hint: "Restart with a larger --max-old-space-size and snapshot earlier, before the heap fills.",
      },
      { status: 500 },
    );
  }
}
