import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { runFullPull } from "@/server/woo/pull";

export const dynamic = "force-dynamic";
// A 2000+-product pull is many paginated Woo calls; give the route room.
export const maxDuration = 800;

/**
 * Scheduled store pull: run the whole Woo REST pull to completion. Trigger from
 * any external scheduler, e.g.
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/pull-store
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
    const progress = await runFullPull();
    const ok = progress.status === "done";
    return NextResponse.json({ ok, progress }, { status: ok ? 200 : 500 });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
