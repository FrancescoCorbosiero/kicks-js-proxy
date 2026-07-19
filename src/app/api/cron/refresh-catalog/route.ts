import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { runKicksdbRefresh } from "@/server/actions/feeds";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** Rounds per invocation (100 SKUs each) — a runaway backstop. */
const MAX_ROUNDS = 50;

/**
 * Scheduled catalog refresh: re-price stale entries until none remain (bounded).
 * Trigger from any external scheduler with
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/refresh-catalog
 * Disabled (503) until CRON_SECRET is set.
 */
export async function POST(req: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let runId: string | undefined;
  let refreshed = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await runKicksdbRefresh({ limit: 100, runId });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: res.error, refreshed }, { status: 500 });
    }
    runId = res.runId ?? runId;
    refreshed += res.refreshed ?? 0;
    if ((res.requested ?? 0) === 0 || (res.remainingStale ?? 0) === 0) {
      return NextResponse.json({ ok: true, refreshed, remainingStale: res.remainingStale ?? 0 });
    }
  }
  return NextResponse.json({ ok: true, refreshed, capped: true });
}
