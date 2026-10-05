import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { drainMedia } from "@/server/woo/media";
import { getLatestPullRun, pullInFlight } from "@/server/woo/pull";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The photo queue, for an external scheduler (with SCHEDULER=off nothing else
 * works it): attaches the photos that are due for up to four minutes — the
 * Publisher's products go on sale with their first — and answers how many
 * steps it took. Call it every few minutes:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/media
 * Disabled (503) until CRON_SECRET is set.
 */
export async function POST(req: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const drain = await drainMedia({
      budgetMs: 4 * 60 * 1000,
      concurrency: 2,
      // Not while a store pull assembles its copy of the store (see the scheduler).
      paused: async () => pullInFlight(await getLatestPullRun()),
    });
    return NextResponse.json({ ok: true, ...drain });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
