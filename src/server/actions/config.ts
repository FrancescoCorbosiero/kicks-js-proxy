"use server";

import { clearConfig, getActiveConfig } from "@/server/config/repo";
import { pricingSummary, type PricingSummary } from "@/server/config/summary";

/** Wipe the stored config and re-seed from defaults.ts; return the new summary. */
export async function resetPricingToDefaults(): Promise<PricingSummary> {
  await clearConfig();
  return pricingSummary(await getActiveConfig());
}
