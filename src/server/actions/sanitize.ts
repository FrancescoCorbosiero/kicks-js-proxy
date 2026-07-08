"use server";

import { getActiveSnapshot } from "@/server/store-json/repo";
import { sanitizeModel, type SanitizeReport } from "@/server/store-json/sanitize";

export interface SanitizeResult {
  ok: boolean;
  error?: string;
  json?: string;
  filename?: string;
  report?: SanitizeReport;
}

/**
 * Produce a sanitized re-import JSON from the active snapshot: drop zero-stock
 * ghost variations and realign pa_taglia to the real sizes. Only changed products
 * are included; everything else is preserved. Synchronous — no Woo calls.
 */
export async function sanitizeStoreJson(): Promise<SanitizeResult> {
  const snapshot = await getActiveSnapshot();
  if (!snapshot) return { ok: false, error: "No store snapshot — upload your store JSON first." };

  try {
    const { output, report } = sanitizeModel(snapshot);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
    return {
      ok: true,
      json: JSON.stringify(output, null, 2),
      filename: `sanitized-${stamp}.json`,
      report,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
