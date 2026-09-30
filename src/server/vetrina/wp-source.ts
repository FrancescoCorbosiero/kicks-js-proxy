import "server-only";
import { env } from "@/lib/env";
import { hubConfig } from "@/config";
import { z } from "zod";
import { requestJson, type HttpError, type RetryPolicy } from "@/server/adapters/http";
import type { BlockWrite, RailFallback, RailWrite } from "@/lib/vetrina/types";
import {
  parseCapabilities,
  parseCards,
  parseHistory,
  parseHomepage,
  parseRailDetail,
  parseWriteResult,
} from "./schemas";
import { VetrinaError, type VetrinaSource } from "./source";

/**
 * The live site: golden-hive-blocks' wc-gh/v1 routes. WooCommerce
 * authenticates "wc-*" namespaces with its REST API keys, so this uses the
 * WOO_* credentials the sync already has — nothing new to configure.
 */

const READ_RETRY: RetryPolicy = { attempts: 3, backoffMs: 400, timeoutMs: 25_000 };
// Never retried: a write that timed out may have landed, and replaying it
// would only earn a confusing "the page changed" from our own first attempt.
const WRITE_ONCE: RetryPolicy = { attempts: 1, backoffMs: 0, timeoutMs: 45_000 };

function apiRoot(): string {
  const base = (env.WOO_BASE_URL ?? "").replace(/\/+$/, "");
  const origin = base.includes("/wp-json") ? base.slice(0, base.indexOf("/wp-json")) : base;
  return `${origin}/wp-json/wc-gh/v1`;
}

function headers(): HeadersInit {
  const token = Buffer.from(`${env.WOO_CONSUMER_KEY}:${env.WOO_CONSUMER_SECRET}`).toString("base64");
  return { Authorization: `Basic ${token}`, Accept: "application/json", "Content-Type": "application/json" };
}

function pageParam(): Record<string, string> {
  const page = hubConfig.vetrina.page;
  return page === "front" ? {} : { page_id: String(page.id) };
}

/** WordPress's error body: { code, message, data: { status } }. */
function wpError(e: unknown): VetrinaError {
  const err = e as HttpError;
  let code = "";
  let message = err.message ?? String(e);
  const status = err.status;
  try {
    const body = JSON.parse(err.body ?? "") as { code?: string; message?: string };
    code = body.code ?? "";
    // Shown under "Dettagli tecnici": WordPress's words plus what identifies
    // the failure (a PHP fatal is "internal_server_error, HTTP 500").
    if (body.message) message = `${body.message} (${[code, status && `HTTP ${status}`].filter(Boolean).join(", ")})`;
  } catch {
    // not JSON: a proxy page, a timeout — keep the transport message
  }
  if (code === "rest_no_route" || (status === 404 && code === "")) {
    return new VetrinaError(
      "plugin_missing",
      "Il sito non risponde alla Vetrina: aggiorna il plugin Golden Hive Blocks alla versione 5.10.0 o successiva.",
      status,
    );
  }
  if (status === 401 || status === 403) return new VetrinaError("unauthorized", message, status);
  if (status === 409) return new VetrinaError("stale", message, status);
  if (status === 404) return new VetrinaError("not_found", message, status);
  if (status === 400 || status === 422) return new VetrinaError("invalid", message, status);
  return new VetrinaError("failed", message, status);
}

async function call(
  method: "GET" | "POST",
  route: string,
  query: Record<string, string> = {},
  body?: unknown,
): Promise<unknown> {
  if (!env.WOO_BASE_URL || !env.WOO_CONSUMER_KEY || !env.WOO_CONSUMER_SECRET) {
    throw new VetrinaError(
      "not_configured",
      "Il collegamento al negozio non è configurato (WOO_BASE_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET).",
    );
  }
  const url = new URL(`${apiRoot()}/${route}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  try {
    return await requestJson(
      url.toString(),
      { method, headers: headers(), cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) },
      method === "GET" ? READ_RETRY : WRITE_ONCE,
    );
  } catch (e) {
    throw wpError(e);
  }
}

/**
 * Validate an answer. A shape the Hub does not understand (a plugin older or
 * newer than this Hub expects) says which route and which field, instead of a
 * wall of Zod issues.
 */
function parsed<T>(route: string, parse: (data: unknown) => T, data: unknown): T {
  try {
    return parse(data);
  } catch (e) {
    const detail = e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? e.message : String(e);
    throw new VetrinaError("failed", `Risposta inattesa da wc-gh/v1/${route}:\n${detail}`);
  }
}

export function wordpressSource(): VetrinaSource {
  return {
    kind: "wordpress",
    async capabilities() {
      return parsed("capabilities", parseCapabilities, await call("GET", "capabilities"));
    },
    async homepage() {
      return parsed("homepage", parseHomepage, await call("GET", "homepage", pageParam()));
    },
    async rail(key, opts = {}) {
      const query: Record<string, string> = { ...pageParam(), key };
      if (opts.offset != null) query.offset = String(opts.offset);
      if (opts.count != null) query.count = String(opts.count);
      if (opts.fallback) query.fallback = opts.fallback satisfies RailFallback;
      return parsed("rail", parseRailDetail, await call("GET", "rail", query));
    },
    async products(ids) {
      if (ids.length === 0) return [];
      return parsed("products", parseCards, await call("GET", "products", { ids: ids.slice(0, 100).join(",") }));
    },
    async writeRail(input: RailWrite) {
      return parsed(
        "homepage/block",
        parseWriteResult,
        await call("POST", "homepage/block", {}, {
          page_id: input.pageId,
          path: input.path,
          block_name: input.blockName,
          expected_modified_gmt: input.expectedModifiedGmt,
          expected_attrs_hash: input.expectedAttrsHash,
          rail: {
            pin: input.pin,
            exclude: input.exclude,
            fallback: input.fallback,
            ...(input.limit != null ? { limit: input.limit } : {}),
          },
          ...(input.fields && Object.keys(input.fields).length > 0 ? { attrs: input.fields } : {}),
          dry_run: input.dryRun ?? false,
        }),
      );
    },
    async writeBlock(input: BlockWrite) {
      return parsed(
        "homepage/block",
        parseWriteResult,
        await call("POST", "homepage/block", {}, {
          page_id: input.pageId,
          path: input.path,
          block_name: input.blockName,
          expected_modified_gmt: input.expectedModifiedGmt,
          expected_attrs_hash: input.expectedAttrsHash,
          attrs: input.fields,
          dry_run: input.dryRun ?? false,
        }),
      );
    },
    async history(key) {
      return parsed("homepage/history", parseHistory, await call("GET", "homepage/history", { ...pageParam(), key }));
    },
  };
}
