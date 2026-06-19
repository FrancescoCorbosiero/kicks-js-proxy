import "server-only";
import { z } from "zod";

/**
 * The ONLY place process.env is read. Everything else imports the typed `env`
 * or the derived `connectionFromEnv()`. Validated once at module load; a missing
 * or malformed secret fails fast instead of surfacing as a confusing runtime 401.
 */
const EnvSchema = z.object({
  // KicksDB
  KICKS_SECRET: z.string().min(1, "KICKS_SECRET is required"),
  KICKS_BASE_URL: z.url().default("https://api.kicks.dev/v3"),

  // WooCommerce — optional: the store integration is JSON round-trip, not live REST.
  WOO_BASE_URL: z.url().optional(),
  WOO_CONSUMER_KEY: z.string().optional(),
  WOO_CONSUMER_SECRET: z.string().optional(),

  // Persistence
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  // App
  DEFAULT_MARKET: z.string().default("IT"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/**
 * Build the ConnectionConfig (from core/config.ts) out of env. Secrets live here
 * and only here — never in the persisted AppConfig rows.
 */
export function connectionFromEnv() {
  return {
    kicksDbApiKey: env.KICKS_SECRET,
    woo: {
      baseUrl: env.WOO_BASE_URL ?? "",
      consumerKey: env.WOO_CONSUMER_KEY ?? "",
      consumerSecret: env.WOO_CONSUMER_SECRET ?? "",
    },
    marketToCurrency: { IT: "EUR", US: "USD", GB: "GBP", DE: "EUR" } as Record<string, string>,
  };
}
