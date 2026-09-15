import { checkBasicAuth } from "@/lib/api-auth";
import { isSyncMode } from "@/server/store-json/sync";
import { roundtripPreview } from "@/server/actions/roundtrip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/gh/v1/roundtrip/preview?mode=update_only[&include=output]
 * body: the round-trip JSON (rp_cm_roundtrip).
 *
 * Dry-run: reprices the file's searchable SKUs against StockX and reports what
 * would change under `mode`. Persists nothing. Pass include=output to also get
 * the would-be re-import file (changed products only).
 */
export async function POST(req: Request): Promise<Response> {
  const denied = checkBasicAuth(req);
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const mode = params.get("mode") ?? "update_only";
  if (!isSyncMode(mode)) {
    return Response.json(
      { ok: false, error: `invalid mode '${mode}' (use update_only|create_only|upsert|replace)` },
      { status: 400 },
    );
  }

  const body = await req.text();
  if (!body.trim()) {
    return Response.json({ ok: false, error: "empty body — POST the round-trip JSON" }, { status: 400 });
  }

  const report = await roundtripPreview(body, mode, params.get("include") === "output");
  return Response.json(report, { status: report.ok ? 200 : 400 });
}
