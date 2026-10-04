import { NextResponse } from "next/server";
import { loadDockStatus } from "@/server/dock/status";

export const dynamic = "force-dynamic";

/**
 * The dock's live numbers (src/components/JourneyDock.tsx polls it). A GET
 * route rather than a server action: actions run one at a time per tab, and
 * a poll must never queue behind a five-minute publish batch.
 */
export async function GET() {
  return NextResponse.json(await loadDockStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
