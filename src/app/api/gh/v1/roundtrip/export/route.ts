import { checkBasicAuth } from "@/lib/api-auth";
import { roundtripExport } from "@/server/actions/roundtrip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/gh/v1/roundtrip/export[?scope=all|searchable]
 *
 * Emits the active round-trip model as the response body (re-postable to
 * preview/apply). `scope=searchable` strips the file to only the SKUs KicksDB
 * can price. SKU stats are returned in X-Roundtrip-* headers so the body stays
 * a clean round-trip file (curl -o roundtrip.json).
 */
export async function GET(req: Request): Promise<Response> {
  const denied = checkBasicAuth(req);
  if (denied) return denied;

  const scope = new URL(req.url).searchParams.get("scope") === "searchable" ? "searchable" : "all";
  const report = await roundtripExport(scope);

  if (!report.ok || !report.model) {
    return Response.json({ ok: false, error: report.error ?? "export failed" }, { status: 400 });
  }

  return new Response(JSON.stringify(report.model, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Roundtrip-Scope": report.scope,
      "X-Roundtrip-Products": String(report.stats?.products ?? 0),
      "X-Roundtrip-Searchable": String(report.stats?.searchable ?? 0),
      "X-Roundtrip-Stripped": String(report.stats?.stripped ?? 0),
    },
  });
}
