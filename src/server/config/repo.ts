import "server-only";
import { eq } from "drizzle-orm";
import type { AppConfig } from "@core/config";
import { db } from "@/server/db/client";
import { config as configTable } from "@/server/db/schema";
import { connectionFromEnv } from "@/lib/env";
import { buildDefaultConfig, goldenSneakersPassthroughRule } from "./defaults";

/**
 * Returns the active AppConfig with its ConnectionConfig (secrets) always taken
 * from env — never from the persisted row. If no active config exists yet, the
 * default is seeded and returned.
 */
export async function getActiveConfig(): Promise<AppConfig> {
  const connection = connectionFromEnv();
  const rows = await db.select().from(configTable).where(eq(configTable.isActive, true)).limit(1);

  if (rows.length === 0) {
    const fresh = buildDefaultConfig(connection);
    await db.insert(configTable).values({ name: "default", data: stripSecrets(fresh), isActive: true });
    return fresh;
  }

  // Overlay env secrets onto the stored (secret-free) config. The GS
  // passthrough rule is ensured at read time so configs stored before the
  // feed existed keep working without a manual Reset.
  return {
    ...rows[0].data,
    pricingRules: ensureOutlierGuard(ensureGsRule(rows[0].data.pricingRules)),
    connection,
  };
}

function ensureGsRule(rules: AppConfig["pricingRules"]): AppConfig["pricingRules"] {
  const hasGs = rules.some((r) => r.scope.source === "goldensneakers");
  return hasGs ? rules : [...rules, goldenSneakersPassthroughRule()];
}

/**
 * Same read-time retrofit for the distribution guard: configs stored before
 * outlierFloorPercent existed get the default on their catch-all rule (and 0
 * on GS rules — supplier presented prices are real, never bad data). An
 * operator's explicit value, including 0, is always respected.
 */
function ensureOutlierGuard(rules: AppConfig["pricingRules"]): AppConfig["pricingRules"] {
  return rules.map((r) => {
    if (r.outlierFloorPercent != null) return r;
    if (r.scope.source === "goldensneakers") return { ...r, outlierFloorPercent: 0 };
    const isCatchAll = Object.keys(r.scope).length === 0;
    return isCatchAll ? { ...r, outlierFloorPercent: 60 } : r;
  });
}

/** Never persist secrets: blank out the ConnectionConfig before writing to DB. */
export function stripSecrets(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    connection: {
      kicksDbApiKey: "",
      woo: { baseUrl: cfg.connection.woo.baseUrl, consumerKey: "", consumerSecret: "" },
      marketToCurrency: cfg.connection.marketToCurrency,
    },
  };
}

/** Delete all stored config rows so the next read re-seeds from defaults.ts. */
export async function clearConfig(): Promise<void> {
  await db.delete(configTable);
}

/** Persist edits to the active config (secrets stripped); insert if none exists. */
export async function saveActiveConfig(cfg: AppConfig): Promise<void> {
  const rows = await db
    .select({ id: configTable.id })
    .from(configTable)
    .where(eq(configTable.isActive, true))
    .limit(1);
  if (rows.length) {
    await db
      .update(configTable)
      .set({ data: stripSecrets(cfg), updatedAt: new Date() })
      .where(eq(configTable.id, rows[0].id));
  } else {
    await db.insert(configTable).values({ name: "default", data: stripSecrets(cfg), isActive: true });
  }
}
