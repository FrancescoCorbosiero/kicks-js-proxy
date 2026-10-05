import { NextResponse, type NextRequest } from "next/server";
import { runPublish } from "@/server/actions/publish";

export const dynamic = "force-dynamic";
// A batch creates up to 25 products on the live store, images included.
export const maxDuration = 300;

/**
 * One publish batch, for the Publish tab: the runPublish server action, as a
 * plain request. Server actions go through the router's queue, and a page
 * change waits behind the one in flight — a batch is up to a minute of
 * product creation, so following any link mid-run froze the Hub for that
 * long. A plain request leaves navigation alone; the batch in flight still
 * completes here.
 */
export async function POST(req: NextRequest) {
  // Same-origin only, as Next itself checks for server actions: being signed
  // in must not let another site's page create products through this browser.
  const origin = req.headers.get("origin");
  if (origin) {
    const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" (a sandboxed frame) or garbage: not this site.
    }
    if (originHost !== host) {
      return NextResponse.json({ ok: false, error: "cross-origin request refused" }, { status: 403 });
    }
  }
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  return NextResponse.json(await runPublish(input), { headers: { "Cache-Control": "no-store" } });
}
