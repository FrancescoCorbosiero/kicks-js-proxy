import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { syncGoldenSneakersFromApi } from "@/server/feeds/goldensneakers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled GoldenSneakers sync: pull the flat assortment and refresh
 * feed_items (deactivate-not-delete). Trigger from any external scheduler:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/sync-goldensneakers
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
    const report = await syncGoldenSneakersFromApi();
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
