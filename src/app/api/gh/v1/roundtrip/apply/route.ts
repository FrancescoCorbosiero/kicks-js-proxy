import { checkBasicAuth } from "@/lib/api-auth";
import { isSyncMode } from "@/server/store-json/sync";
import { roundtripApply } from "@/server/actions/roundtrip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/gh/v1/roundtrip/apply?mode=update_only
 * body: the round-trip JSON (rp_cm_roundtrip).
 *
 * Commit: reprices the file's searchable SKUs, merges the changes into the
 * active snapshot (the new committed store state), and returns the lean
 * re-import file (`output`: changed products only) to load back into Woo.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = checkBasicAuth(req);
  if (denied) return denied;

  const mode = new URL(req.url).searchParams.get("mode") ?? "update_only";
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

  const report = await roundtripApply(body, mode);
  return Response.json(report, { status: report.ok ? 200 : 400 });
}
