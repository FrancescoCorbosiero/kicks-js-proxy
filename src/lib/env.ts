import "server-only";
import { z } from "zod";
import { isTimeZone, parseTimes } from "@/lib/schedule";

/**
 * The ONLY place process.env is read. Everything else imports the typed `env`
 * or the derived `connectionFromEnv()`. Validated once at module load; a missing
 * or malformed secret fails fast instead of surfacing as a confusing runtime 401.
 */
/**
 * An optional secret, tolerant of the way hosting panels and compose files
 * pass "unset": KICKS_SECRET= with nothing after it is absent, not a
 * zero-length key that should crash the app at boot.
 */
const optionalSecret = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

/** An optional setting where a blank value (X= in a compose file) means unset. */
const blankIsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);

const parsesAsTimes = (value: string) => {
  try {
    parseTimes(value);
    return true;
  } catch {
    return false;
  }
};

const EnvSchema = z.object({
  // KicksDB
  // Optional: a shop that sells only supplier-feed products (GoldenSneakers)
  // has no KicksDB account. Without it every KicksDB-backed path degrades to
  // "no data from this source" instead of failing the app.
  KICKS_SECRET: optionalSecret,
  KICKS_BASE_URL: z.url().default("https://api.kicks.dev/v3"),

  // WooCommerce REST — powers the live sync (pull store state, push prices).
  // Optional: without them the Sync tab explains what to configure, and the
  // hidden file round-trip flow (/preview) still works.
  WOO_BASE_URL: z.url().optional(),
  WOO_CONSUMER_KEY: z.string().optional(),
  WOO_CONSUMER_SECRET: z.string().optional(),

  // Shared secret for the scheduled endpoints (/api/cron/*). Unset = disabled.
  CRON_SECRET: z.string().optional(),

  // Automatic self-repair inside the daily scheduler: put back missing
  // pictures / brand / category on products already online. OFF by default —
  // it is the only pass that WRITES to the live store unattended, and arming
  // that is the operator's decision, not a default.
  AUTO_REPAIR: z.enum(["on", "off"]).optional(),

  // In-app scheduler (src/server/scheduler.ts). Default: on in production,
  // off in dev; set explicitly to override either way.
  SCHEDULER: z.enum(["on", "off"]).optional(),
  // When the daily sync runs: HH:MM times, comma-separated, in
  // SCHEDULER_TIMEZONE. Default 04:30, Europe/Rome.
  SCHEDULER_TIMES: blankIsUnset(
    z
      .string()
      .refine((v) => parsesAsTimes(v), "SCHEDULER_TIMES is a list of HH:MM times, e.g. 04:30 or 04:30,13:30")
      .optional(),
  ),
  SCHEDULER_TIMEZONE: blankIsUnset(
    z.string().refine((v) => isTimeZone(v), "SCHEDULER_TIMEZONE is an IANA time zone, e.g. Europe/Rome").optional(),
  ),
  // Minutes between two pulls of the recent orders. Default 15; 0 = off.
  SCHEDULER_ORDERS_MINUTES: blankIsUnset(z.coerce.number().int().min(0).max(1440).optional()),
  // Called (GET) after every fully successful daily sync: point a dead man's
  // switch at it (healthchecks.io, Uptime Kuma push, ...) to hear about a sync
  // that failed or never ran.
  SCHEDULER_HEARTBEAT_URL: blankIsUnset(z.url().optional()),
  // The feed cycle: every N minutes on the clock (30 → :00 and :30), the
  // supplier feed is refreshed and, with AUTO_SYNC=on, its products' changes
  // are written to the store. Default 0 = off (the feeds refresh daily only).
  SCHEDULER_FEEDS_MINUTES: blankIsUnset(
    z.coerce
      .number()
      .int()
      .refine((v) => v === 0 || (v >= 5 && v <= 720), "SCHEDULER_FEEDS_MINUTES is 0 (off) or 5–720 minutes")
      .optional(),
  ),
  // Called after every fully successful feed cycle, like the heartbeat above.
  SCHEDULER_FEEDS_HEARTBEAT_URL: blankIsUnset(z.url().optional()),

  // Automatic store sync: after the feeds refresh, write the planned price and
  // stock changes to the LIVE store — the feed's products every feed cycle,
  // the whole store in the daily sync. Prices and stock only: no size cleanup,
  // no deletions. OFF by default: arming unattended writes to the shop is the
  // operator's decision, as with AUTO_REPAIR.
  AUTO_SYNC: z.enum(["on", "off"]).optional(),
  // An automatic run that would change more variations than this writes
  // nothing and says so on the Feeds tab: a change that large is reviewed in
  // the Sync tab first. Default 500.
  AUTO_SYNC_MAX_CHANGES: blankIsUnset(z.coerce.number().int().min(1).optional()),

  // GoldenSneakers feed — the flat-assortment endpoint (include VAT/markup
  // query params there: presented_price arrives FINAL) and its bearer token.
  // Optional: without them the Feeds tab falls back to manual JSON upload.
  GS_FEED_URL: z.url().optional(),
  GS_FEED_TOKEN: z.string().optional(),

  // Where the Vetrina reads the homepage: the live site (golden-hive-blocks'
  // wc-gh/v1 API, authenticated with the WOO_* keys) or an in-memory demo
  // shop. Overrides hub.config.ts, so local dev can use the demo untouched.
  VETRINA_SOURCE: z.enum(["wordpress", "fixture"]).optional(),
  // The Vetrina's own address (e.g. vetrina.resellpiacenza.shop): the same
  // app answers there with the Vetrina only — "/" is its home, the operator
  // tabs stay on the Hub's address. Unset = no split.
  VETRINA_HOST: z
    .string()
    .regex(/^[a-z0-9.-]+$/i, "VETRINA_HOST is a bare hostname, e.g. vetrina.example.com")
    .optional(),

  // Sign-in is Authelia's, in front of the app (docs/auth.md): Caddy adds
  // this secret to every request it lets through, and src/proxy.ts refuses
  // the rest. It is read there from process.env; this only checks its shape
  // at boot. Letters and digits only: it is written into a Caddy label.
  // Unset = open app (local dev).
  AUTH_PROXY_SECRET: blankIsUnset(
    z
      .string()
      .regex(/^[A-Za-z0-9]{32,}$/, "AUTH_PROXY_SECRET is 32 or more letters and digits: openssl rand -hex 32")
      .optional(),
  ),

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
    kicksDbApiKey: env.KICKS_SECRET ?? "",
    woo: {
      baseUrl: env.WOO_BASE_URL ?? "",
      consumerKey: env.WOO_CONSUMER_KEY ?? "",
      consumerSecret: env.WOO_CONSUMER_SECRET ?? "",
    },
    marketToCurrency: { IT: "EUR", US: "USD", GB: "GBP", DE: "EUR" } as Record<string, string>,
  };
}
