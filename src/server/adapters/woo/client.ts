import "server-only";
import { WooStoreAdapter } from "@core/core-spine";
import { requestJson, type RetryPolicy, DEFAULT_RETRY } from "../http";

export interface WooConfig {
  baseUrl: string; // store root, e.g. https://shop.example.com
  consumerKey: string;
  consumerSecret: string;
  retry?: RetryPolicy;
}

/**
 * Concrete WooCommerce REST v3 client. HTTP Basic auth (consumer key/secret)
 * over HTTPS. Structurally satisfies the `WooClient` the WooStoreAdapter expects
 * ({ get, post }). Paths are relative to /wp-json/wc/v3/.
 */
export class WooHttpClient {
  private readonly apiRoot: string;
  private readonly authHeader: string;
  private readonly retry: RetryPolicy;

  constructor(cfg: WooConfig) {
    this.apiRoot = cfg.baseUrl.replace(/\/?$/, "/") + "wp-json/wc/v3/";
    this.authHeader =
      "Basic " + Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString("base64");
    this.retry = cfg.retry ?? DEFAULT_RETRY;
  }

  private url(path: string, query?: Record<string, string>): string {
    const u = new URL(path.replace(/^\//, ""), this.apiRoot);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return requestJson<T>(
      this.url(path, query),
      { method: "GET", headers: { Authorization: this.authHeader, Accept: "application/json" } },
      this.retry,
    );
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(
      this.url(path),
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      this.retry,
    );
  }
}

/** Build the StorePort-implementing adapter from a Woo config. */
export function createWooStore(cfg: WooConfig): WooStoreAdapter {
  return new WooStoreAdapter(new WooHttpClient(cfg));
}
